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
 * 呼び出し結果は担当者の mockCallOutcome で決定的に分岐する: staff-suzuki → timeout（未応答）。
 *
 * ## 🔴 何を縛っているか (#826)
 *
 * 1. **段の順序**（dialing → waiting → preTimeoutNotice → result-timeout）
 * 2. **予告の保持時間**。順序だけでは足りない —— 予告が 1 フレームだけ DOM に載って即座に
 *    結果へ飛んでも順序列は同一になるので、**保持を無効化する変異が素通りする**。
 * 3. **レンダラが詰まっても 1・2 が保たれること**（下の「停止注入」テスト）
 *
 * ## なぜ瞬時値で待たないか
 *
 * 各段が画面に出ている時間は full suite 並行下で**どれも 300ms 未満**（実測: dialing 約 208ms →
 * waiting 約 299ms → preTimeoutNotice 約 292ms）。`toHaveAttribute` の瞬時値待ちはポーリングが
 * 1 回飛ぶと段の窓を丸ごと越え、その後 calling 自体が消えるので二度と観測できない。
 * そこで MutationObserver で遷移を**取りこぼしなく記録**し、待つのは消えない終端シグナルだけにする。
 */

/** 記録の置き場（ページ側 window に生やす一時キー）。 */
const TRAIL_KEY = '__callingStageTrail';
/** 予告の最低保持 ms。URL クエリと assert の両方がこの 1 つの定数から引く。 */
const HOLD_MS = 300;
const STAGE_QUERY = `callingStageMs=200&callingNoticeMs=500&callingNoticeHoldMs=${HOLD_MS}`;

/**
 * 同期応答経路（mock が `/call` で即 `timeout` を返す）用。🔴 **予告しきい値をテストの
 * 制限時間より長く置く。**
 *
 * こうしないと変異検出力が落ちる。短いしきい値（500ms）だと、「確定しても経過を待つ」変異
 * （= `outcomeResolved` を無視する変異）でも予告は 500ms 後に出てしまうので、段列も保持時間も
 * 正常と区別できず**変異が生存する**（実測: 緩めた直後に kill が 2→1 へ減った）。
 * 30 秒に置けば、変異体は制限時間内に予告へ到達できず**必ず**落ちる。
 */
const SYNC_NOTICE_MS = 30_000;
const SYNC_STAGE_QUERY = `callingStageMs=200&callingNoticeMs=${SYNC_NOTICE_MS}&callingNoticeHoldMs=${HOLD_MS}`;

/**
 * PSTN 用のしきい値。**予告(3000ms)を `/status` の初回ポーリング(約 3 秒)より後ろに置く**。
 *
 * ここが #832 の再現条件そのもので、停止注入は要らない ── PSTN の欠陥は**構造的**である。
 * サーバが予告しきい値より前に `timeout` を返すと、`handleStatusPoll` が予告を待たずに
 * `CALL_TIMEOUT` を dispatch するので、来訪者は `waiting` の文言から**予告を 1 度も見ずに**
 * 未応答画面へ飛ぶ（既定しきい値では予告 25s に対しサーバは数秒〜十数秒で返すため、
 * 実運用では**ほぼ必ず**こうなる）。
 */
/**
 * PSTN 用のしきい値。🔴 **予告しきい値を 30 秒に置く** —— テストの制限時間(20s)より長い。
 *
 * これが変異検出の要である。結果が確定したら経過を待たず予告段へ進む（#832）ので、正しい実装は
 * **数秒で**予告を出して遷移する。一方「確定しても経過を待つ」実装（＝この修正を戻した変異）は
 * 予告が 30 秒後まで出ないので、**制限時間内に `result-timeout` へ到達できず必ず落ちる**。
 *
 * しきい値を短く置くと、変異体も同じ段列を出してしまい、判定が保持時間の数百 ms 差だけに
 * なる ―― 負荷次第で変異が生存する（レース依存の kill）。**段列そのもので落とす**ほうが堅い。
 */
const PSTN_NOTICE_MS = 30_000;
const PSTN_STAGE_QUERY = `callingStageMs=200&callingNoticeMs=${PSTN_NOTICE_MS}&callingNoticeHoldMs=${HOLD_MS}`;

/** 段の遷移列（時刻つき）と、経過インジケータの観測高さ。 */
type StageTrail = { stages: { stage: string; at: number }[]; pulseHeight: number };

/**
 * `data-calling-stage` の遷移と経過インジケータを記録し始める。**confirm-call の前に呼ぶこと。**
 *
 * 🔴 **属性の「現在値」をループの中で読まない。** `record.target.getAttribute()` は
 * *コールバック時点の最終値*を返すので、1 コールバックに属性 record が 2 件束ねられると
 * `dialing → (最終値)preTimeoutNotice → waiting → …` と**順序が壊れて偽の赤になる**。
 * しかも record が束ねられるのは「レンダラが詰まって複数コミットが 1 タスクに入ったとき」＝
 * #826 が再現する条件そのもの。よってループ内では `oldValue` だけを積み、
 * 現在値はループを抜けてから 1 度だけ確定させる（連続する属性変化は、次の record の
 * `oldValue` が前の現在値そのものなので、これで漏れない）。
 */
async function recordCallingStageTrail(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const trail: StageTrail = { stages: [], pulseHeight: 0 };
    (window as unknown as Record<string, StageTrail>)[key] = trail;

    const push = (value: string | null | undefined) => {
      if (!value) return;
      const last = trail.stages[trail.stages.length - 1];
      if (last?.stage === value) return;
      trail.stages.push({ stage: value, at: performance.now() });
    };
    const has = (root: Element, selector: string) =>
      root.matches(selector) || root.querySelector(selector) !== null;
    const scan = (root: Element) => {
      const panel = root.matches('[data-calling-stage]')
        ? root
        : root.querySelector('[data-calling-stage]');
      if (panel) push(panel.getAttribute('data-calling-stage'));
      const pulse = root.matches('[data-testid="calling-pulse"]')
        ? root
        : root.querySelector('[data-testid="calling-pulse"]');
      // 存在チェックだけでは display:none / 高さ 0 の退行を素通りするので実寸を採る。
      if (pulse) trail.pulseHeight = Math.max(trail.pulseHeight, pulse.getBoundingClientRect().height);
      if (has(root, '[data-testid="result-timeout"]')) push('result-timeout');
    };

    new MutationObserver((records) => {
      let pending: Element | null = null;
      const flush = () => {
        if (pending) push(pending.getAttribute('data-calling-stage'));
        pending = null;
      };
      for (const record of records) {
        if (record.type === 'attributes') {
          push(record.oldValue);
          if (record.target instanceof Element) pending = record.target;
          continue;
        }
        flush();
        for (const added of record.addedNodes) {
          if (added instanceof Element) scan(added);
        }
      }
      flush();
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
    return { stages: [...trail.stages], pulseHeight: trail.pulseHeight };
  }, TRAIL_KEY);
}

/** 呼び出し(calling)まで進める。無操作リセットの短縮は指定しない (#476)。 */
async function callSuzuki(page: Page): Promise<void> {
  await page.goto(`/kiosk?${SYNC_STAGE_QUERY}`);
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await revealStaff(page, 'staff-staff-suzuki');
  await page.getByTestId('staff-staff-suzuki').click();
  await page.getByTestId('visitor-name').fill('来客 一郎');
  await page.getByTestId('to-confirm').click();
}

/**
 * 実 PSTN 発信を模す。`/call` は `state:'calling'`（ビデオセッション無し）で返し、
 * 結果は `/status` ポーリングで確定させる ── これが**実運用で来訪者が一番踏む経路**である。
 *
 * 🔴 **`vonageSessionId` を返さないこと。** 返すとビデオビュー（`KioskCallView`）が開き、
 * `data-calling-stage` パネルごと別経路になる（`shouldOpenVideoView`）。
 */
async function stubPstnTimeout(page: Page): Promise<void> {
  await page.route('**/api/kiosk/receptions/*/call', (route) =>
    route.fulfill({ json: { state: 'calling' } }),
  );
  await page.route('**/api/kiosk/receptions/*/status', (route) =>
    route.fulfill({ json: { state: 'timeout' } }),
  );
}

/**
 * PSTN 経路で呼び出しまで進める。**予告しきい値をポーリングより後ろに置く**ことが肝で、
 * 「サーバが予告より前に結果を返す」という #832 の条件をここで作っている。
 */
async function callViaPstn(page: Page): Promise<void> {
  await page.goto(`/kiosk?${PSTN_STAGE_QUERY}`);
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await revealStaff(page, 'staff-staff-sato');
  await page.getByTestId('staff-staff-sato').click();
  await page.getByTestId('visitor-name').fill('来客 三郎');
  await page.getByTestId('to-confirm').click();
}

/**
 * 段の順序と、予告の実保持時間を縛る。
 *
 * 🔴 **`waiting` を通るかは「結果がいつ確定したか」で変わる** (#832)。結果が確定すると
 * 経過を待たず予告段へ進むので、mock のように即座に確定する経路では `waiting` が出ない。
 * よって期待する段列は呼び出し側が渡す（暗黙の既定値を置くと、段が消えた退行を素通りする）。
 */
function expectNoticeHonoured(trail: StageTrail, stages: string[]): void {
  expect(trail.stages.map((s) => s.stage)).toEqual(stages);
  expectNoticeHeld(trail);
}

/**
 * **結果が確定してから遷移する経路**の段列を縛る。
 *
 * 🔴 **`waiting` の有無は主張しない。** 出るかどうかは「サーバが答えるまでに `waitingAfterMs`
 * を跨いだか」で決まり、並行実行の負荷次第で変わる（実測: 単独では出ず、full suite では出た）。
 * 縛りたいのは**予告が飛ばないこと**であって段の本数ではないので、時間依存の部分は主張しない。
 *
 * 検出力は落ちない。予告を飛ばす変異は「予告が結果の直前に居る」で落ち、予告を一瞬で
 * 通過させる変異は `expectNoticeHeld` の保持時間で落ちる。
 */
function expectNoticeBeforeResult(trail: StageTrail): void {
  const stages = trail.stages.map((x) => x.stage);
  expect(stages[0]).toBe('dialing');
  // 予告は必ず出て、**結果の直前**に居る（段を飛ばして結果へ行っていない）。
  expect(stages.slice(-2)).toEqual(['preTimeoutNotice', 'result-timeout']);
  // 途中に現れてよいのは `waiting` だけ（未知の段や逆行が混ざっていないこと）。
  expect(stages.slice(1, -2).every((x) => x === 'waiting')).toBe(true);
  expectNoticeHeld(trail);
}

/** 予告の**実保持時間**だけを縛る（段列の主張とは独立に使う）。 */
function expectNoticeHeld(trail: StageTrail): void {
  const notice = trail.stages.find((s) => s.stage === 'preTimeoutNotice')!;
  const result = trail.stages.find((s) => s.stage === 'result-timeout')!;
  // 🔴 順序だけでは「予告が 1 フレームで通過した」を検出できない。保持そのものを測る。
  // 下限は計測誤差ぶん緩める（保持を無効化する変異では差が 0 近傍になるので十分に落ちる）。
  expect(result.at - notice.at).toBeGreaterThanOrEqual(HOLD_MS * 0.8);
  // AC1: 画面が「動いて」いる（経過インジケータが実寸を持って出ている）。
  expect(trail.pulseHeight).toBeGreaterThan(0);
}

test('同期応答: 結果が確定したら予告しきい値を待たず、予告を経てから遷移する (#323 AC3)', async ({
  page,
}) => {
  await callSuzuki(page);
  await recordCallingStageTrail(page);
  await page.getByTestId('confirm-call').click();

  // 待つのは**消えない終端シグナル**だけ。段の観測は recorder が担う。
  await expect(page.getByTestId('result-timeout')).toBeVisible({ timeout: 15_000 });
  // mock は `/call` で即 timeout を返すので結果は開始時点で確定しており、予告段へ直行して
  // 保持ぶん見せてから遷移する (#832)。`waiting` を跨ぐかは応答速度次第なので主張しない。
  expectNoticeBeforeResult(await readCallingStageTrail(page));
});

/**
 * 🔴 **#826 の回帰拘束。** 上のテストは「レンダラが詰まらなければ」旧実装でも緑になる
 * （実測 11 サンプルすべてで同じ順序列が出た）。落ちるのは詰まったときだけなので、
 * **詰まりを注入しないと修正を縛れない**。
 *
 * 予告の保持を「呼び出し開始からの経過」起点で数えていた旧実装では、ここで段階更新と
 * CALL_TIMEOUT の dispatch がどちらも期限切れになり、React が 1 コミットへ畳んで
 * **preTimeoutNotice が一度も DOM に載らない**。実測で `origin/main` はこのテストで赤、
 * 本 PR で緑になる。
 *
 * グローバル状態は書き換えないので専用 project は要らない（塞ぐのは自分のページの
 * メインスレッドだけ）。
 */
test('レンダラが詰まっても予告は飛ばない (#826 回帰)', async ({ page }) => {
  await callSuzuki(page);
  await recordCallingStageTrail(page);

  // 🔴 **起点は `dialing`** (#832)。結果が即確定する mock 経路では `waiting` が出ないので、
  // `waiting` を待つ書き方だと**注入そのものが走らず、このテストが空虚に通る**。
  // dialing を観測した 150ms 後から 700ms 塞ぎ、予告の commit と dispatch を同じ窓へ入れる。
  await page.evaluate(() => {
    const obs = new MutationObserver(() => {
      const el = document.querySelector('[data-testid="calling"]');
      if (el?.getAttribute('data-calling-stage') !== 'dialing') return;
      obs.disconnect();
      setTimeout(() => {
        (window as unknown as Record<string, boolean>).__stallInjected = true;
        const until = Date.now() + 700;
        while (Date.now() < until) {
          /* メインスレッドを塞ぐ */
        }
      }, 150);
    });
    obs.observe(document.body, { subtree: true, childList: true, attributes: true });
  });

  await page.getByTestId('confirm-call').click();
  await expect(page.getByTestId('result-timeout')).toBeVisible({ timeout: 20_000 });
  expectNoticeBeforeResult(await readCallingStageTrail(page));

  // 🔴 **注入が本当に走ったことを確かめる** (#826 レビュー MINOR-1)。observer が段を
  // 掴み損ねると 700ms のブロックは起きず、このテストは上の非注入テストと同一になる。
  // 「詰まっても飛ばない」を主張しているのに詰まらせていない、を無言で許さない。
  expect(await page.evaluate(() => (window as unknown as Record<string, boolean>).__stallInjected)).toBe(
    true,
  );
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

/**
 * 🔴 **#832 の回帰拘束（実 PSTN 経路）。**
 *
 * 上の 2 本が縛っているのは `/call` が**同期で** `timeout` を返す経路だけで、これは mock の
 * 都合である。実運用の PSTN は `/call` が `calling` で返り、結果は `/status` ポーリングで
 * 後から届く ―― そちらは #826 の予告保持ゲートを**素通り**していた（修正前の実測遷移列は
 * `dialing → result-timeout` で、`waiting` すら出ない）。
 *
 * ここでは予告しきい値を 30 秒（テストの制限時間より長い）に置いてあるので、
 * 「結果が確定したら経過を待たず予告段へ進む」が効いていなければ**制限時間内に終わらない**。
 * 停止注入は要らない ―― PSTN の欠陥はタイミング依存ではなく構造的である。
 */
test('PSTN: 結果が確定したら予告しきい値を待たず、予告を見せてから遷移する (#832)', async ({
  page,
}) => {
  await stubPstnTimeout(page);
  await callViaPstn(page);
  await recordCallingStageTrail(page);
  await page.getByTestId('confirm-call').click();

  await expect(page.getByTestId('result-timeout')).toBeVisible({ timeout: 20_000 });

  // 🔴 **`waiting` の有無は主張しない。** 出るかどうかは「サーバが答えるまでに
  // `waitingAfterMs`(200ms) を跨いだか」で決まり、並行実行の負荷次第で変わる（実測: 単独では
  // 出ず、full suite では出た）。ここで縛りたいのは**予告が飛ばないこと**であって段の本数
  // ではないので、時間依存の部分を主張から外す ―― 外さないと**偽の赤**になる。
  //
  // 検出力は落ちていない。この修正を戻した変異は予告が 30 秒後まで出ないので、
  // 上の `toBeVisible({ timeout: 20_000 })` に到達できず**必ず**落ちる（実測 22.6s で失敗）。
  expectNoticeBeforeResult(await readCallingStageTrail(page));
});

/**
 * 🔴 **下界**（#832）。上のテストは「予告を早く出す」ことしか主張しないので、
 * **常に予告段を返す**実装（= 段階演出そのものを潰す変異）でも通ってしまう。
 *
 * 結果がまだ確定していない間は従来どおり段が進むことを、実経路で対に縛る。
 * これは #323 AC1「呼び出し中に段階に応じて文言が変わる」の実 PSTN 版でもある。
 */
test('PSTN: 結果が未確定の間は従来どおり段階が進む（下界・#323 AC1）', async ({ page }) => {
  // `/status` を 2 回 `calling` で返してから `timeout` にする。予告しきい値(500ms)は
  // その前に越えるので、来訪者は dialing → waiting → preTimeoutNotice を順に見る。
  await page.route('**/api/kiosk/receptions/*/call', (route) =>
    route.fulfill({ json: { state: 'calling' } }),
  );
  let turn = 0;
  await page.route('**/api/kiosk/receptions/*/status', (route) => {
    turn += 1;
    return route.fulfill({ json: { state: turn <= 2 ? 'calling' : 'timeout' } });
  });

  await page.goto(`/kiosk?${STAGE_QUERY}`);
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await revealStaff(page, 'staff-staff-sato');
  await page.getByTestId('staff-staff-sato').click();
  await page.getByTestId('visitor-name').fill('来客 五郎');
  await page.getByTestId('to-confirm').click();
  await recordCallingStageTrail(page);
  await page.getByTestId('confirm-call').click();

  await expect(page.getByTestId('result-timeout')).toBeVisible({ timeout: 20_000 });
  expectNoticeHonoured(await readCallingStageTrail(page), [
    'dialing',
    'waiting',
    'preTimeoutNotice',
    'result-timeout',
  ]);
});

/**
 * 🔴 **`failed` を予告ゲートへ送らない** (#832)。
 *
 * 予告は「まもなく打ち切る」の告知なので、**結果が出た側を遅らせる理由が無い**。とりわけ
 * `failed`（発信そのものの失敗 ＝ `contact_failed`）を timeout の保留へ載せてしまうと、
 * 来訪者は待たされた末に**未応答**（`person_unavailable`）画面を見る ―― `call-poll.ts` が
 * 「give_up と未応答を混同しない」と強調している区別が無言で潰れる。
 *
 * 保留は `sessionId` しか持たず、発火側が `CALL_TIMEOUT` を固定で dispatch する構造なので、
 * **この変異は型では止まらない。** 落とすのはこのテストだけである。
 */
test('PSTN: サーバが failed を返したら、予告を挟まず失敗として出す (#832)', async ({ page }) => {
  await page.route('**/api/kiosk/receptions/*/call', (route) =>
    route.fulfill({ json: { state: 'calling' } }),
  );
  await page.route('**/api/kiosk/receptions/*/status', (route) =>
    route.fulfill({ json: { state: 'failed' } }),
  );

  // 予告しきい値は 30 秒。`failed` が保留へ載る変異では制限時間内に何も出ない。
  await callViaPstn(page);
  await page.getByTestId('confirm-call').click();

  await expect(page.getByTestId('result-failed')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('result-timeout')).toHaveCount(0);
});
