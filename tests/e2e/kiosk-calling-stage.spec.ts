import { test, expect, revealStaff } from './kiosk-fixtures';
import { MIN_DIALING_FLOOR_MS } from '@/domain/reception/calling-experience';
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
 * 1. **段の順序**。ただし `waiting` を通るかは「結果がいつ確定したか」で変わる (#832) ――
 *    確定すると `waiting` を飛ばして予告段へ進むので、**段列を完全一致で縛るのは
 *    確定が遅い経路だけ**（下の PSTN 下界テスト）。他は `expectNoticeBeforeResult` で
 *    「予告が結果の直前に居る」を縛る
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
/**
 * ビデオ経路。コントローラの応答待ちを 600ms に縮め、予告しきい値は 30s のまま。
 * 「結果が確定したら予告へ進む」が効いていなければ制限時間内に終わらない。
 */
const VIDEO_ANSWER_MS = 600;
const VIDEO_STAGE_QUERY = `${PSTN_STAGE_QUERY}&callTimeoutMs=${VIDEO_ANSWER_MS}`;

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
 * Vonage ビデオ経路。`vonageSessionId` を返して KioskCallView を開き、SDK は接続したまま
 * 相手が来ない（streamCreated 無し）。コントローラが timeout すると親がゲートへ送る。
 *
 * 🔴 **addInitScript は goto より前。** 後からでは既存ドキュメントに載らない。
 */
async function stubVideoTimeout(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const ot = {
      initSession() {
        return {
          connect(_token: string, cb: (err?: unknown) => void) {
            cb();
          },
          publish() {},
          on() {},
          disconnect() {},
        };
      },
      initPublisher() {
        return { destroy() {} };
      },
    };
    (window as unknown as { OT: typeof ot }).OT = ot;
  });
  await page.route('**/api/kiosk/receptions/*/call', (route) =>
    route.fulfill({ json: { state: 'calling', vonageSessionId: 'sess-video' } }),
  );
  await page.route('**/api/kiosk/receptions/*/token', (route) =>
    route.fulfill({
      json: {
        applicationId: 'app-e2e',
        sessionId: 'sess-video',
        token: 'tok-e2e',
        role: 'publisher',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }),
  );
  await page.route('**/api/kiosk/receptions/*/timeout', (route) => route.fulfill({ json: { ok: true } }));
  await page.route('**/api/kiosk/receptions/*/connected', (route) =>
    route.fulfill({ json: { ok: true } }),
  );
}

async function callViaVideo(page: Page): Promise<void> {
  await stubVideoTimeout(page);
  await page.goto(`/kiosk?${VIDEO_STAGE_QUERY}`);
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await revealStaff(page, 'staff-staff-sato');
  await page.getByTestId('staff-staff-sato').click();
  await page.getByTestId('visitor-name').fill('来客 ビデオ');
  await page.getByTestId('to-confirm').click();
}

/**
 * 段の順序と、予告の実保持時間を縛る。
 *
 * 🔴 **`waiting` を通るかは「結果がいつ確定したか」で変わる** (#832)。結果が確定すると
 * 経過を待たず予告段へ進むので、mock のように即座に確定する経路では `waiting` が出ない。
 * よって期待する段列は呼び出し側が渡す（暗黙の既定値を置くと、段が消えた退行を素通りする）。
 */
/**
 * 指定 URL の応答が**解決した時刻**を page 側へ記録する（テストが窓に入った証人）。
 *
 * 🔴 **証人が無いと、レイテンシが伸びただけで検査したい事象が窓の外へ出て、変異が沈黙して
 * 素通りする。** 6・7 周目で 2 度これを踏んだので、採り方を 1 か所へ寄せる。
 */
async function recordResolveTime(page: Page, urlPart: string, key: string): Promise<void> {
  await page.addInitScript(
    ([part, storeKey]) => {
      const w = window as unknown as Record<string, unknown>;
      w[storeKey] = null;
      const original = window.fetch;
      window.fetch = async (...args: Parameters<typeof fetch>) => {
        const response = await original(...args);
        const url = typeof args[0] === 'string' ? args[0] : String((args[0] as Request).url ?? '');
        if (url.includes(part) && w[storeKey] === null) w[storeKey] = performance.now();
        return response;
      };
    },
    [urlPart, key] as const,
  );
}

async function readResolveTime(page: Page, key: string): Promise<number> {
  const at = await page.evaluate((k) => (window as unknown as Record<string, number | null>)[k], key);
  // `addInitScript` が当たらないとキーは `undefined` になる。`not.toBeNull()` はそれを
  // 素通しするので、数値であることを直接主張する（8 周目レビュー MINOR-2）。
  expect(at, `${key}: 応答が観測されていない`).toEqual(expect.any(Number));
  return at!;
}

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

  // 🔴 **注入は `confirm-call` の押下と同時に始める** (#832 2 周目レビュー MAJOR-2)。
  //
  // 以前は「`dialing` を観測した 150ms 後」に塞いでいたが、新設計では予告 commit が
  // `dialing` の **25〜36ms 後**に起きるため、**ブロックが始まる前に予告は commit 済み**だった
  // （実測 4/4 回）。検査したい事象が窓の外にあり、このテストは隣の非注入テストの重複に
  // なっていた ―― #826 の逆変異（`noticeShownAtMs === null` → `return 0`）に対する kill が
  // **2 → 0** へ落ちていた（PR 前後で同じ変異を当てた実測）。
  //
  // 🔴 **このテストは #826 の null ガード（`noticeShownAtMs === null`）を落とさない。**
  // 実測した機構を書いておく ―― かつてここに「構造的に到達不能だから」と書いたが**それは誤り**
  // だった（到達不能なら逆変異が kill されるはずがないのに、隣の 2 本が kill している）。
  //
  // 正しくは**結果が着弾した時点の経過が床を越えているか**の違いである。同期/PSTN は
  // 25〜36ms で着弾するので床未満 ＝ 段は `dialing` のままで、予告記録 effect の deps が
  // 変わらず、ゲートが null を読む。このテストは 700ms 塞ぐので着弾時に既に床を越えており、
  // 同一コミットで段が `preTimeoutNotice` になって記録 effect が先に走る ―― だから踏まない。
  //
  // よって null ガードは**隣の 2 本が既に覆っている**（実測 kill 2）。increment 2 へ送る
  // 必要は無い。このテストが守るのは「**詰まっても段列と保持が壊れない**」ことである。
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__stallAt = undefined;
    document.addEventListener(
      'click',
      (ev) => {
        if (!(ev.target instanceof Element)) return;
        if (ev.target.closest('[data-testid="confirm-call"]') === null) return;
        setTimeout(() => {
          // 🔴 **塞ぐ直前の段を採る。** bool だけでは「注入は走ったが、検査したい事象は
          // 窓の外だった」を許してしまう（それが今回の欠陥だった）。
          const panel = document.querySelector('[data-calling-stage]');
          w.__stallAt = panel === null ? 'no-panel' : String(panel.getAttribute('data-calling-stage'));
          const until = Date.now() + 700;
          while (Date.now() < until) {
            /* メインスレッドを塞ぐ */
          }
        }, 0);
      },
      { capture: true },
    );
  });

  await page.getByTestId('confirm-call').click();
  await expect(page.getByTestId('result-timeout')).toBeVisible({ timeout: 20_000 });
  expectNoticeBeforeResult(await readCallingStageTrail(page));

  // 🔴 **予告が commit される「前」に塞ぎ始めたこと**を確かめる。`preTimeoutNotice` に
  // なっていたら窓が遅すぎで、このテストは #826 の欠陥を検査できていない。
  const stallAt = await page.evaluate(() => (window as unknown as Record<string, unknown>).__stallAt);
  expect(stallAt).toBeDefined();
  expect(stallAt).not.toBe('preTimeoutNotice');
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

/**
 * 🔴 **床の実時間を、しきい値を縮めない条件で縛る**（#832 3 周目レビュー MAJOR-2）。
 *
 * 他の spec は全部 `callingStageMs` を 100〜200 に縮めており、床は
 * `Math.min(MIN_DIALING_MS, waitingAfterMs)` で clamp されるので **`MIN_DIALING_MS` を
 * 3000 → 250 に狭める変異が全部素通りする**（実測: unit 6853 本すべて PASS）。
 * ここは `callingStageMs` を床より長く置き、**予告に到達するまでの実時間**を測る。
 */
test('確定しても、床のあいだは「呼び出しています」を見せる (#832 MAJOR-2 回帰)', async ({
  page,
}) => {
  // 床(3s) < waitingAfterMs(15s) なので clamp は効かず、床がそのまま出る。
  // 予告しきい値 30s は経過では到達しないので、予告段へ入るのは床の経過が理由だと確定する。
  // 🔴 同型の証人。確定が**床より前**に届いていなければ、`notice.at` は確定時刻に引きずられて
  // 2500 を超えるので、床を狭める変異が素通りする（MAJOR-1 と同じ構造）。
  await recordResolveTime(page, '/call', '__callResolvedAt');
  await page.goto('/kiosk?callingStageMs=15000&callingNoticeMs=30000&callingNoticeHoldMs=300');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await revealStaff(page, 'staff-staff-suzuki');
  await page.getByTestId('staff-staff-suzuki').click();
  await page.getByTestId('visitor-name').fill('来客 六郎');
  await page.getByTestId('to-confirm').click();
  await recordCallingStageTrail(page);
  await page.getByTestId('confirm-call').click();

  await expect(page.getByTestId('result-timeout')).toBeVisible({ timeout: 20_000 });
  const trail = await readCallingStageTrail(page);
  const dialing = trail.stages.find((x) => x.stage === 'dialing')!;
  const notice = trail.stages.find((x) => x.stage === 'preTimeoutNotice')!;
  // 床は 3s。計測誤差ぶん緩めるが、狭める変異（250ms 等）は必ず落ちる。
  expect(notice.at - dialing.at).toBeGreaterThanOrEqual(2_500);
  // 証人: 確定が床より十分前に届いていること（そうでなければ上の assert は確定時刻を
  // 測っているだけで、床を検査していない）。
  const resolvedSinceDialing = (await readResolveTime(page, '__callResolvedAt')) - dialing.at;
  expect(resolvedSinceDialing, `確定が遅すぎて床を検査できていない（${Math.round(resolvedSinceDialing)}ms）`).toBeLessThan(2_000);
});

/**
 * 🔴 **PSTN 経路でも、レンダラが詰まって予告は飛ばない**（#832 AC3）。
 *
 * AC は「**3 経路すべて**について、レンダラが詰まっても予告が飛ばないことを e2e で縛る」。
 * 停止注入は同期経路にしか無く、increment 1 が配線した 2 経路目（PSTN）が未充足だった
 * （1〜7 周目レビューで繰り返し MINOR として挙がっていた宿題）。
 *
 * ゲートは 1 か所へ集約されているので同期版と重複に近いが、**「重複に近い」は増分の外へ
 * 出す理由にならない** —— #826 の教訓は「宣言順の推論が外れた」ことなので、推論で閉じない。
 */
test('PSTN: レンダラが詰まっても予告は飛ばない (#832 AC3)', async ({ page }) => {
  await stubPstnTimeout(page);
  await callViaPstn(page);
  await recordCallingStageTrail(page);

  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__stallAt = undefined;
    document.addEventListener(
      'click',
      (ev) => {
        if (!(ev.target instanceof Element)) return;
        if (ev.target.closest('[data-testid="confirm-call"]') === null) return;
        setTimeout(() => {
          const panel = document.querySelector('[data-calling-stage]');
          w.__stallAt = panel === null ? 'no-panel' : String(panel.getAttribute('data-calling-stage'));
          const until = Date.now() + 700;
          while (Date.now() < until) {
            /* メインスレッドを塞ぐ */
          }
        }, 0);
      },
      { capture: true },
    );
  });

  await page.getByTestId('confirm-call').click();
  await expect(page.getByTestId('result-timeout')).toBeVisible({ timeout: 20_000 });
  expectNoticeBeforeResult(await readCallingStageTrail(page));

  // 証人: 予告が commit される前に塞ぎ始めたこと。
  const stallAt = await page.evaluate(() => (window as unknown as Record<string, unknown>).__stallAt);
  expect(stallAt).toBeDefined();
  expect(stallAt).not.toBe('preTimeoutNotice');
});

/**
 * 🔴 **応答が遅れても段が後退しない**（#832 5 周目レビュー MAJOR-1 の回帰）。
 *
 * レビューが `/status` を 300ms 遅らせるプローブで、**PSTN 4/4・同期 3/3 で決定的に**
 * 段の後退（`waiting → dialing`）を再現した。機構は `useCallingStage` の tick が
 * 0ms → `waitingAfterMs+10` → 以後 500ms 刻みで、`waiting` を commit した後に
 * `timeoutPending` が (210ms, 710ms) の窓で立つと、`elapsedMs` が 210 のまま
 * 床未満と判定されて `dialing` へ落ちる、というもの。
 *
 * 無遅延では窓に入らないので**現状のスイートは緑のまま**であり、並行負荷で数百 ms
 * 遅れたときだけ落ちる ―― `retries` が flaky として吸収するので緑と誤読される。
 * CLAUDE.md が #787 / #826 で名指ししている型なので、**遅延を注入して固定する**。
 */
test('応答が遅れても段は後退しない (#832 MAJOR-1 回帰)', async ({ page }) => {
  await page.route('**/api/kiosk/receptions/*/call', (route) =>
    route.fulfill({ json: { state: 'calling' } }),
  );
  await page.route('**/api/kiosk/receptions/*/status', async (route) => {
    // 🔴 `waiting` が commit された後・床に達する前に確定が届く窓へ入れる。
    await new Promise((resolve) => setTimeout(resolve, 300));
    return route.fulfill({ json: { state: 'timeout' } });
  });
  await recordResolveTime(page, '/status', '__statusResolvedAt');

  // 床(500) > waitingAfterMs(200) になる設定。ここが後退の起きる条件。
  await page.goto('/kiosk?callingStageMs=200&callingNoticeMs=30000&callingNoticeHoldMs=300');
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await revealStaff(page, 'staff-staff-sato');
  await page.getByTestId('staff-staff-sato').click();
  await page.getByTestId('visitor-name').fill('来客 七郎');
  await page.getByTestId('to-confirm').click();
  await recordCallingStageTrail(page);
  await page.getByTestId('confirm-call').click();

  await expect(page.getByTestId('result-timeout')).toBeVisible({ timeout: 20_000 });

  // 段の rank が単調非減少であること（`expectNoticeBeforeResult` より直接的に後退を見る）。
  const trail = await readCallingStageTrail(page);
  const order = ['dialing', 'waiting', 'preTimeoutNotice', 'result-timeout'];
  const ranks = trail.stages.map((x) => order.indexOf(x.stage));
  expect(ranks, `段が後退した: ${trail.stages.map((x) => x.stage).join(' → ')}`).toEqual(
    [...ranks].sort((a, b) => a - b),
  );
  // 下界: 予告を経ていること（後退が無いだけの空虚な合格を防ぐ）。
  expect(trail.stages.map((x) => x.stage)).toContain('preTimeoutNotice');

  // 🔴 **証人**: 確定が「`waiting` を commit した後・**床に達する前**」の窓へ実際に入ったこと。
  //
  // 上界は**床**から採る。前版は tick 格子（0 → 210 → 710）から 700 を置いていたが、
  // これは導出の誤りだった ―― `timeoutPending` が立つと effect が deps 変化で再実行され、
  // `tick()` が `Date.now()` を採り直すので `elapsed` は stale にならない。後退が起きるのは
  // **`elapsed < 床` のときだけ**で、実際の窓は (210, 500)。700 のままだと (500, 700) の
  // 200ms 帯が盲目になり、create が 250ms 遅れるだけで**変異が沈黙して生存**した（実測）。
  const dialingAt = trail.stages.find((x) => x.stage === 'dialing')!.at;
  const sinceDialing = (await readResolveTime(page, '__statusResolvedAt')) - dialingAt;
  const message = `窓を外した（確定が calling 起点 ${Math.round(sinceDialing)}ms・床 ${MIN_DIALING_FLOOR_MS}ms）`;
  // 🔴 **下界は literal ではなく実観測から採る。** 前版は `WAITING_COMMIT_MS = 210` という
  // literal で、対になる `callingStageMs` はインライン文字列だった ―― しきい値を触ると
  // 窓だけがずれて沈黙する（7 周目に上界で直したのと同じ構造が反対側に残っていた）。
  // `waiting` の実時刻から採れば、**`waiting` が実際に出たこと**も同時に縛れる
  // （出ていなければ後退は原理的に起こらず、変異が沈黙する）。
  const waitingAt = trail.stages.find((x) => x.stage === 'waiting')?.at;
  expect(waitingAt, `waiting が観測されていない: ${trail.stages.map((x) => x.stage).join(' → ')}`).toBeDefined();
  expect(sinceDialing, message).toBeGreaterThan(waitingAt! - dialingAt);
  // json パースと commit のぶんだけ手前で切る（床ちょうどだと境界で揺れる）。
  expect(sinceDialing, message).toBeLessThan(MIN_DIALING_FLOOR_MS - 50);
});

/**
 * 🔴 **ラッチを次の来訪者へ持ち越さない**（#832 6 周目レビュー MAJOR-1 の回帰）。
 *
 * ラッチは今回の増分で新設した「受付をまたいで生き残りうる唯一の state」である。
 * `calling` を抜けたときのリセット 1 行を削除しても、**unit 6860 本・e2e 269 本すべてが
 * 通る**ことが実測された ―― 危険面を作ったのに検査がゼロだった。
 *
 * iPad は再読み込みされない常設端末なので、1 人目が未応答で終わった直後の 2 人目は、
 * リセットが無いと「呼ぶ」を押した瞬間に諦めの予告パネルから始まる。しかも
 * `noticeShownAtRef` が calling 突入時に立つので**予告保持ゲートが最初から満了済み**になり、
 * 床も保持も丸ごと無効化される。CLAUDE.md が `targetTab` で名指ししている
 * 「前の来訪者の状態が次の来訪者へ持ち越される」型。
 */
test('前の来訪者の状態を次へ持ち越さない (#832 MAJOR-1 回帰)', async ({ page }) => {
  // 🔴 **2 人目は「応答あり」にする。** 2 人目も timeout にすると、状態を持ち越しても
  // **同じ画面に着いてしまう**ので、`pendingTimeout` のリセットを外す変異が素通りする
  // （8 周目レビュー実測: 13 本すべて生存）。ラッチのリセットだけを縛っていた前版の穴。
  //
  // 持ち越すと `timeoutPending` が 2 人目の開始時点から真になり、床(3s)＋保持(2s)＝**5 秒**で
  // **1 人目の sessionId** で `CALL_TIMEOUT` が撃たれる。実運用の PSTN 応答（数秒〜十数秒）
  // より速いので、**担当者が受話器を取っても「応答がありませんでした」画面**が出る。
  //
  // この増分が露出を広げた点も重要: main では発火が `noticeAfterMs`(25s)＋保持(5s)＝30 秒後で
  // 実応答に追いつけなかったが、5 秒へ縮めたことで現実の応答より速く誤発火する窓ができた。
  let secondReception = false;
  let statusTurn = 0;
  await page.route('**/api/kiosk/receptions/*/call', (route) =>
    route.fulfill({ json: { state: 'calling' } }),
  );
  await page.route('**/api/kiosk/receptions/*/status', (route) => {
    if (!secondReception) return route.fulfill({ json: { state: 'timeout' } });
    statusTurn += 1;
    // 2 人目は約 6 秒で担当者が応答する現実的な列。
    return route.fulfill({ json: { state: statusTurn <= 2 ? 'calling' : 'connected' } });
  });

  await callViaPstn(page);
  await page.getByTestId('confirm-call').click();
  await expect(page.getByTestId('result-timeout')).toBeVisible({ timeout: 20_000 });

  // 逃げ道バーから待機画面へ戻り、**同じ端末のまま** 2 人目の受付を始める。
  await page.getByTestId('escape-reset').click();
  secondReception = true;
  await page.getByTestId('start-reception').click();
  await page.getByTestId('purpose-meeting').click();
  await revealStaff(page, 'staff-staff-sato');
  await page.getByTestId('staff-staff-sato').click();
  await page.getByTestId('visitor-name').fill('来客 八郎');
  await page.getByTestId('to-confirm').click();
  await recordCallingStageTrail(page);
  await page.getByTestId('confirm-call').click();

  // 🔴 **2 人目はちゃんと「応答あり」に着く。** 持ち越すと 5 秒で誤って未応答へ倒れる。
  await expect(page.getByTestId('result-connected')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('result-timeout')).toHaveCount(0);
  // 段のラッチも持ち越さない（2 人目は `dialing` から始まる）。
  const trail = await readCallingStageTrail(page);
  expect(
    trail.stages[0]?.stage,
    `2 人目が引き継いだ: ${trail.stages.map((x) => x.stage).join(' → ')}`,
  ).toBe('dialing');
});

/**
 * 🔴 **#832 の回帰拘束（Vonage ビデオ経路）。**
 *
 * `vonageSessionId` が立つと KioskCallView が CallingView を**置き換えて**いたため、
 * `data-calling-stage` が DOM に無く、`onTimeout` がゲートを素通りして即 CALL_TIMEOUT していた。
 * 設計判断: ビデオはメディア寿命だけを駆動し、待ち体験は CallingView のまま。timeout は
 * PSTN と同じ `pendingTimeout` へ送る。
 */
test('ビデオ: 結果が確定したら予告しきい値を待たず、予告を見せてから遷移する (#832)', async ({
  page,
}) => {
  await callViaVideo(page);
  await recordCallingStageTrail(page);
  await page.getByTestId('confirm-call').click();

  await expect(page.getByTestId('calling')).toBeVisible({ timeout: 15_000 });
  // 映像ボックスは CSS 寸法が無く Playwright は hidden と見る。経路の証人は attached。
  await expect(page.getByTestId('kiosk-call')).toBeAttached();
  await expect(page.getByTestId('result-timeout')).toBeVisible({ timeout: 20_000 });
  expectNoticeBeforeResult(await readCallingStageTrail(page));
});

test('ビデオ: レンダラが詰まっても予告は飛ばない (#832 AC3)', async ({ page }) => {
  await callViaVideo(page);
  await recordCallingStageTrail(page);
  await page.getByTestId('confirm-call').click();
  await expect(page.getByTestId('calling')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('kiosk-call')).toBeAttached();

  // ビデオの timeout はコントローラの短タイマー。CallingView が乗った直後に塞いで
  // 「確定と予告が同一タスクへ畳まれる」窓を作る。
  const stallAt = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const panel = document.querySelector('[data-calling-stage]');
    w.__stallAt = panel === null ? 'no-panel' : String(panel.getAttribute('data-calling-stage'));
    const until = Date.now() + 700;
    while (Date.now() < until) {
      /* メインスレッドを塞ぐ */
    }
    return w.__stallAt;
  });
  expect(stallAt).toBeDefined();
  expect(stallAt).not.toBe('preTimeoutNotice');

  await expect(page.getByTestId('result-timeout')).toBeVisible({ timeout: 20_000 });
  expectNoticeBeforeResult(await readCallingStageTrail(page));
});
