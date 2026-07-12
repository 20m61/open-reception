import { expect, type Page } from '@playwright/test';

/**
 * soak ハーネスのブラウザ操作ヘルパ (issue #317)。
 *
 * `tests/e2e/soak/*.spec.ts` から使う。判定ロジック（閾値超過の合否）は持たず
 * （それは `tests/soak/thresholds.ts` の純関数が担う）、ここでは「1 サイクル分の
 * 受付操作」「メトリクス採取」「障害注入（ネットワーク断・タブ非表示）」だけを行う。
 */

/** 受付完了後の自動待機画面復帰を待つ上限（KioskFlow の AUTO_RESET_MS より余裕を持たせる）。 */
const WAIT_FOR_IDLE_TIMEOUT_MS = 10_000;

/**
 * 待機画面 → 受付完了 → 待機画面復帰までの 1 サイクルを、担当者検索や部署選択を混ぜずに
 * 最短経路で実行する（soak はループ回数を稼ぐことが目的で、分岐網羅は他 e2e が担う）。
 */
export async function runReceptionCycle(page: Page, visitorName = '来客 soak'): Promise<void> {
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await page.getByTestId('staff-staff-sato').click();
  await page.getByTestId('visitor-name').fill(visitorName);
  await page.getByTestId('to-confirm').click();
  await page.getByTestId('confirm-call').click();
  await expect(page.getByTestId('result-connected')).toBeVisible();
  await page.getByTestId('complete').click();
  await expect(page.getByTestId('completed')).toBeVisible();
  await expect(page.getByTestId('start-reception')).toBeVisible({ timeout: WAIT_FOR_IDLE_TIMEOUT_MS });
}

export type MemorySample = {
  timestamp: number;
  /** performance.memory は Chromium 限定。非対応ブラウザ/環境では null。 */
  usedJSHeapSize: number | null;
  domNodes: number;
};

/** JS heap 使用量・DOM ノード数を採取する (issue #317)。 */
export async function sampleMetrics(page: Page): Promise<MemorySample> {
  const sample = await page.evaluate(() => {
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
    return {
      usedJSHeapSize: perf.memory ? perf.memory.usedJSHeapSize : null,
      domNodes: document.getElementsByTagName('*').length,
    };
  });
  return { timestamp: Date.now(), ...sample };
}

/**
 * console エラー / 未捕捉例外を収集する。返り値の配列は呼び出し後も生き続けるため、
 * ループ終了後にまとめて閾値判定へ渡す。
 */
export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

export type HeartbeatSample = { ok: boolean; timestamp: number };

/** heartbeat エンドポイントを直接叩いて疎通を記録する (issue #30 の継続性検証)。 */
export async function pollHeartbeat(page: Page, kioskId = 'kiosk-dev'): Promise<HeartbeatSample> {
  const timestamp = Date.now();
  try {
    const res = await page.request.get(`/api/kiosk/heartbeat?kioskId=${encodeURIComponent(kioskId)}`);
    return { ok: res.ok(), timestamp };
  } catch {
    return { ok: false, timestamp };
  }
}

/**
 * ネットワーク断→復帰を模す (issue #30 の自動復旧劣化検知)。`context.setOffline` は
 * BrowserContext 単位のため、他タブが無い soak では page.context() で十分。
 */
export async function toggleNetworkOutage(page: Page, outageMs: number): Promise<void> {
  const context = page.context();
  await context.setOffline(true);
  await page.waitForTimeout(outageMs);
  await context.setOffline(false);
}

/**
 * タブ非表示→復帰を模す。実ブラウザでバックグラウンドタブ化を Playwright から直接起こす API は
 * 無いため、`document.visibilityState`/`hidden` を上書きし `visibilitychange` を発火させて、
 * アプリ側のリスナー（あれば）に非表示/復帰を通知する。
 */
export async function toggleTabVisibility(page: Page, hiddenMs: number): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(hiddenMs);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
