import { test, expect, revealStaff } from './kiosk-fixtures';
import type { Page } from '@playwright/test';

/**
 * 呼び出し中の待ち体験 (issue #323) の E2E。
 *
 * 「呼び出し中に画面が動いており、段階に応じて文言/アバターが変わる」「タイムアウトへの遷移が
 * 予告付きで、突然感がない」を、既存 `?inactivityMs=` の流儀に倣ったタイマー短縮クエリで
 * 決定的に検証する:
 *   - `?callingStageMs=` … dialing → waiting へ切り替わる経過 ms
 *   - `?callingNoticeMs=` … waiting → preTimeoutNotice（タイムアウト直前の予告）へ切り替わる経過 ms
 *   - `?callingNoticeHoldMs=` … 予告を見せてから実際に CALL_TIMEOUT へ遷移するまでの最低保持 ms
 *
 * 呼び出し結果は担当者の mockCallOutcome で決定的に分岐する（reception-flow.spec.ts と同じ担当者
 * フィクスチャ）: staff-suzuki → timeout（未応答）。予告を挟んでからでないと result-timeout に
 * 到達しないことを、段階の出現順序で確認する。
 *
 * ## 🔴 段階を「その瞬間の値」で見ない (#826)
 *
 * かつてここは `expect(calling).toHaveAttribute('data-calling-stage', 'waiting', {timeout: 3_000})`
 * のように**瞬時値**を段ごとに待っていた。しかし各段が画面に出ている時間は**どれも 300ms 未満**
 * である（クラウド linux・full suite 並行下の実測: calling 出現から dialing 208ms → waiting
 * 299ms → preTimeoutNotice 292ms → result-timeout）。Playwright のポーリングが負荷で 1 回でも
 * ~300ms 空くと**段の窓を丸ごと飛び越え**、その後 calling 自体が消えるので二度と観測できない。
 * これが #826 の「5 回に 1 回 flaky」の正体で、実装側は決定的である（同条件 6 本の計測が
 * すべて同じ timeline を出した）。
 *
 * そこで**観測を非破壊にする**: MutationObserver で段の遷移を**取りこぼしなく記録**し、
 * 溜まった順序列に対して 1 度だけアサートする。待つ対象は消えない終端シグナル
 * （result-timeout の出現）だけで、固定の `timeout: 3_000` は持たない。
 * 検出力は上がっている —— 旧版は「その値をいつか観測できた」しか言えず、余計な段や段の
 * 逆行・重複を素通ししたが、本版は**完全な順序列**を縛る。
 */

/** 記録の置き場（ページ側 window に生やす一時キー）。 */
const TRAIL_KEY = '__callingStageTrail';

/** 段の遷移列と、経過インジケータを一度でも見たか。ページ側で組み立ててそのまま持ち帰る。 */
type StageTrail = { stages: string[]; sawPulse: boolean };

/**
 * `data-calling-stage` の遷移と、経過インジケータ（calling-pulse）の出現を記録し始める。
 *
 * **confirm-call を押す前に呼ぶこと。** calling パネルはクリック後に mount されるので、
 * childList も併せて観測して mount 時の初期値（dialing）を拾う。
 * 属性変化は `oldValue` → 現在値の順に積む。こうするとコールバックが束ねられても
 * 中間値が落ちない（記録が「取りこぼしなし」である根拠）。
 */
async function recordCallingStageTrail(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const trail: StageTrail = { stages: [], sawPulse: false };
    (window as unknown as Record<string, StageTrail>)[key] = trail;

    const push = (value: string | null | undefined) => {
      if (value && trail.stages[trail.stages.length - 1] !== value) trail.stages.push(value);
    };
    const has = (root: Element, selector: string) =>
      root.matches(selector) || root.querySelector(selector) !== null;
    const scan = (root: Element) => {
      const panel = root.matches('[data-calling-stage]')
        ? root
        : root.querySelector('[data-calling-stage]');
      if (panel) push(panel.getAttribute('data-calling-stage'));
      if (has(root, '[data-testid="calling-pulse"]')) trail.sawPulse = true;
      if (has(root, '[data-testid="result-timeout"]')) push('result-timeout');
    };

    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') {
          push(record.oldValue);
          push(
            record.target instanceof Element
              ? record.target.getAttribute('data-calling-stage')
              : null,
          );
          continue;
        }
        for (const added of record.addedNodes) {
          if (added instanceof Element) scan(added);
        }
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['data-calling-stage'],
    });
  }, TRAIL_KEY);
}

async function readCallingStageTrail(page: Page): Promise<StageTrail> {
  return page.evaluate((key) => {
    const trail = (window as unknown as Record<string, StageTrail>)[key];
    return { stages: [...trail.stages], sawPulse: trail.sawPulse };
  }, TRAIL_KEY);
}

test('呼び出し中は段階的に文言が変わり、タイムアウトは予告を経てから遷移する (#323 AC1/AC3)', async ({
  page,
}) => {
  // 無操作リセットの短縮は指定しない。calling は INACTIVITY_RESET_STATES に含まれず
  // （state.ts）本テストの検証対象にも関わらないため、一律に短縮しても利益が無く、
  // calling へ至る 6 ステップの操作を警告オーバーレイの横取りに晒すだけだった (#476)。
  await page.goto('/kiosk?callingStageMs=200&callingNoticeMs=500&callingNoticeHoldMs=300');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await revealStaff(page, 'staff-staff-suzuki');
  await page.getByTestId('staff-staff-suzuki').click();
  await page.getByTestId('visitor-name').fill('来客 一郎');
  await page.getByTestId('to-confirm').click();

  await recordCallingStageTrail(page);
  await page.getByTestId('confirm-call').click();

  // 待つのは**消えない終端シグナル**だけ。段の観測は上の recorder が担うので、
  // ここが遅れても（負荷で描画が詰まっても）記録は失われない。
  await expect(page.getByTestId('result-timeout')).toBeVisible({ timeout: 15_000 });

  const trail = await readCallingStageTrail(page);
  // AC1: 経過に応じて段階が dialing → waiting → preTimeoutNotice と進む。
  // AC3: result-timeout は**必ず preTimeoutNotice の後**（予告を経てから遷移し、突然飛ばない）。
  // 完全一致で縛るので、段の飛ばし・逆行・重複・余計な段のいずれも落とせる。
  expect(trail.stages).toEqual(['dialing', 'waiting', 'preTimeoutNotice', 'result-timeout']);
  // AC1: 画面が「動いて」いる（常時アニメーションする経過インジケータ）。
  expect(trail.sawPulse).toBe(true);
});

test('しきい値を長めにすると dialing のまま既存どおり即結果へ進む（後方互換）', async ({ page }) => {
  // しきい値を省略（既定値のまま）にすると、mock アダプタは瞬時に応答するため段階演出が
  // ボトルネックにならず、従来どおり result-connected へ素早く到達する（回帰確認）。
  await page.goto('/kiosk');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await revealStaff(page, 'staff-staff-sato');
  await page.getByTestId('staff-staff-sato').click();
  await page.getByTestId('visitor-name').fill('来客 二郎');
  await page.getByTestId('to-confirm').click();
  await page.getByTestId('confirm-call').click();

  await expect(page.getByTestId('result-connected')).toBeVisible();
});
