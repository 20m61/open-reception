import { test, expect } from '../kiosk-fixtures';
import { evaluateSoakRun, parseSoakMode } from '../../soak/thresholds';
import {
  collectConsoleErrors,
  pollHeartbeat,
  runReceptionCycle,
  sampleMetrics,
  toggleNetworkOutage,
  toggleTabVisibility,
  type HeartbeatSample,
  type MemorySample,
} from './soak-driver';

/**
 * 1 営業日連続稼働 soak テスト (issue #317)。
 *
 * 待機 → 受付完走を `SOAK_MODE` が指すモード分だけ長時間ループ駆動し、JS heap・DOM ノード数・
 * heartbeat 継続・console エラーを定期サンプリングして閾値判定する。閾値超過で FAIL する。
 *
 * モード（`SOAK_MODE` 環境変数、既定 `smoke`）:
 *   smoke（既定・2 分）… ローカル/CI で毎回検証できる短時間版。`npm run test:soak`。
 *   30m / 2h / 8h        … opt-in の長時間版。`npm run test:soak:30m` 等（charter の
 *                          「1 営業日連続稼働」相当は 8h を複数回、または実機 soak #65 で担保）。
 *
 * このファイルは `playwright.soak.config.ts` 経由でのみ実行され、既定の `npm run test:e2e` /
 * `scripts/quality-gate.sh --pr` の対象からは除外されている（playwright.config.ts の
 * testIgnore、および本ファイルが `tests/e2e/soak/` にあること自体で二重に構造分離している）。
 */
test.describe('soak: kiosk 長時間連続稼働', () => {
  test('待機→受付完走を繰り返しても heap/DOM/heartbeat/エラーが閾値内に収まる', async ({ page }) => {
    const config = parseSoakMode(process.env.SOAK_MODE);

    const consoleErrors = collectConsoleErrors(page);
    await page.goto('/kiosk');

    const memorySamples: MemorySample[] = [await sampleMetrics(page)];
    const heartbeats: HeartbeatSample[] = [await pollHeartbeat(page)];

    const deadline = Date.now() + config.totalMs;
    let cycle = 0;

    while (Date.now() < deadline) {
      await runReceptionCycle(page);
      cycle += 1;

      if (cycle % config.sampleIntervalCycles === 0) {
        memorySamples.push(await sampleMetrics(page));
        heartbeats.push(await pollHeartbeat(page));
      }

      if (cycle % config.recoveryIntervalCycles === 0) {
        // ネットワーク断→復帰・タブ非表示→復帰を周期的に挟み、自動復旧 (#30) の劣化を検出する。
        await toggleNetworkOutage(page, 2_000);
        await toggleTabVisibility(page, 1_000);
        // 復帰後も待機画面が生きていること（白画面/操作不能に陥っていないこと）を都度確認する。
        await expect(page.getByTestId('start-reception')).toBeVisible({ timeout: 15_000 });
        heartbeats.push(await pollHeartbeat(page));
      }
    }

    // ループ終端の最終状態も 1 点採取する。
    memorySamples.push(await sampleMetrics(page));
    heartbeats.push(await pollHeartbeat(page));

    // smoke モードでも最低 1 サイクルは回っていること（ループ自体が機能していることの保証）。
    expect(cycle, 'soak ループが 1 サイクルも回らなかった（totalMs が短すぎる可能性）').toBeGreaterThan(0);

    const result = evaluateSoakRun({
      mode: config.mode,
      memorySamples,
      heartbeats,
      consoleErrors,
      expectedHeartbeatIntervalMs: config.maxHeartbeatGapMs,
      maxHeapGrowthPercent: config.maxHeapGrowthPercent,
    });

    expect(result.passed, `soak 判定 FAIL:\n${result.reasons.join('\n')}`).toBe(true);
  });
});
