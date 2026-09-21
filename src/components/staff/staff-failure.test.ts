/**
 * 担当者画面の失敗表示が**原因を偽らない** (#1123)。
 *
 * ## 何が問題だったか
 *
 * #1021 が `CALL_ANSWER_SECRET` を failClosed にした結果、担当者向け API は **5xx を
 * 返しうる**ようになった。`StaffCallView` / `StaffResponseActions` は非 ok を一括で
 * `error` にし、「**リンクの有効期限切れ**、または…の可能性があります」と出していたので、
 * 原因が**サーバの設定漏れ**でも担当者には「リンク切れ」と伝わる。
 *
 * 🔴 **今日この症状を見る担当者は居ない** —— 応答リンクを発行する経路が未配線
 * （`issueAnswerToken` の本番呼び出し元はゼロ）。配線された時点で「担当者は再送を待ち、
 * 来訪者は待たされ、運用者には何の信号も出ない」が現実になるので、**その前に直しておく**。
 *
 * これは #973 が admin ログインで塞ぎ、#1021 が `loginFailureForStatus` で塞ぎ直したのと
 * **同型・同一原因**である。同じ形で解く。
 *
 * 縛る不変条件:
 *
 * > 「リンクの有効期限切れ」と出してよいのは、**サーバが要求を検査したうえで断ったとき
 * > （4xx）だけ**である。5xx はサーバ側の問題で、リンクは無関係。
 */
import { describe, expect, it } from 'vitest';
import {
  staffCallFailureMessage,
  staffFailureForStatus,
  staffResponseFailureMessage,
  type StaffFailure,
} from './staff-failure';

const ALL: StaffFailure[] = ['rejected', 'unavailable', 'unreachable'];

/**
 * 🔴 **既存の不変条件は、応答種別の有無に依らず成り立たねばならない (#1137)。**
 *
 * 文言に引数が増えたので、片方の値でしか確かめないと**もう片方が野放し**になる
 * （「リンクのせいにしない」が 0 件のときだけ破れる、という形が作れてしまう）。
 * 総当たりで縛る。
 */
const CONTEXTS = [{ responsesAvailable: true }, { responsesAvailable: false }] as const;
const callMessages = (f: StaffFailure): string[] => CONTEXTS.map((c) => staffCallFailureMessage(f, c));

describe('状態コードから失敗の種類への写像 (#1123)', () => {
  it.each([403, 409, 400, 404, 401])('%i は rejected（サーバが検査したうえで断った）', (s) => {
    expect(staffFailureForStatus(s)).toBe('rejected');
  });

  /**
   * 🔴 本体。503 は #1123 が新設した「サーバ側の問題」で、リンクのせいではない。
   *
   * 🔴 **`not.toBe('rejected')` では足りない。** union は 3 メンバあるので、5xx を
   * `'unreachable'`（＝「届いたか分かりません」）へ倒す変異が**片側主張では生存する**
   * —— レビュー 6 周目の実測で、この unit 33 本が全部緑のままだった
   * （e2e が拾うので合計では塞がっているが、`--fast` では見えない）。値そのものを縛る。
   */
  it.each([500, 502, 503, 504])('🔴 %i は unavailable（サーバ側の問題と伝える）', (s) => {
    expect(staffFailureForStatus(s)).toBe('unavailable');
  });
});

describe('文言 (#1123)', () => {
  it.each(ALL)('%s の文言は空でない（role="status" の空段落は報告していないのと同じ）', (f) => {
    for (const message of callMessages(f)) expect(message.trim().length).toBeGreaterThan(0);
    expect(staffResponseFailureMessage(f).trim().length).toBeGreaterThan(0);
  });

  it.each(CONTEXTS)('原因ごとに文言が全部違う（2 つが同じなら区別した意味がない） %o', (context) => {
    expect(new Set(ALL.map((f) => staffCallFailureMessage(f, context))).size).toBe(ALL.length);
    expect(new Set(ALL.map(staffResponseFailureMessage)).size).toBe(ALL.length);
  });

  /** 🔴 rejected 以外で「リンク」のせいにしない。 */
  it.each<StaffFailure>(['unavailable', 'unreachable'])('🔴 %s の文言がリンクのせいにしない', (f) => {
    for (const message of callMessages(f)) expect(message).not.toContain('リンク');
    expect(staffResponseFailureMessage(f)).not.toContain('リンク');
  });

  /** 🔴 下界。rejected では従来どおりリンク切れの可能性を伝える（全部を曖昧にしない）。 */
  it('🔴 rejected ではリンク切れの可能性を伝える（下界）', () => {
    for (const message of callMessages('rejected')) expect(message).toContain('リンク');
    expect(staffResponseFailureMessage('rejected')).toContain('リンク');
  });

  /**
   * 🔴 **存在しない導線を指さない (#1137)。**
   *
   * `unreachable` の文言は「下の応答からの返答も試せます」と `StaffResponseActions` を
   * 名指しする。ところがサイト設定で応答種別を**全部無効化**していると、そこには
   * 見出しだけが残りボタンは 0 個になる —— 担当者は画面下を探しに行き、その間
   * **来訪者は呼び出しが成立したまま待つ**（answer API は 200 を返し終えている）。
   *
   * 🔴 **引数は必須にする。** 既定値で補うと、**その既定が嘘側（「試せます」）へ倒れる**
   * —— このファイルが #1123 で `SubmitState` に対して同じ理由で採った形に揃える。
   */
  /**
   * 🔴 **「省略できない」こと自体を縛る（実測 D1 で生存した）。**
   *
   * 文脈を任意引数にして `{ responsesAvailable: true }` を既定にする変異は、
   * **今の呼び出し側が全部明示しているので実行時には何も変わらず**、unit も e2e も
   * 素通りした。しかしそれは**次に足す呼び出し側が黙って嘘側へ倒れる**形である
   * （このモジュールが #1123 で `SubmitState` に対して避けたのと同じ穴）。
   *
   * 型で止まることを型で主張する: 既定値を足すと `@ts-expect-error` が**未使用**になり、
   * `tsc`（ゲートの typecheck / build）が落ちる。vitest は型検査をしないので、
   * **この 1 行の効き目はゲート側にある**。
   */
  it('🔴 文脈を省略した呼び出しは型で止まる', () => {
    // @ts-expect-error 文脈は必須（既定値を持たせると「応答導線は在る」＝嘘側へ倒れる。#1137）
    const omitted = () => staffCallFailureMessage('unreachable');
    // 下界: この行が「呼び出しとして成立している」こと（別の型エラーで通っていない）。
    expect(typeof omitted).toBe('function');
  });

  it('🔴 応答種別が 0 件なら、応答導線を指す 1 文を出さない', () => {
    expect(staffCallFailureMessage('unreachable', { responsesAvailable: false })).not.toContain(
      '下の応答',
    );
  });

  /** 🔴 下界: 1 件でも在れば従来どおり指す（全部を曖昧にしない）。 */
  it('🔴 応答種別が在れば、従来どおり応答導線を指す（下界）', () => {
    expect(staffCallFailureMessage('unreachable', { responsesAvailable: true })).toContain(
      '下の応答',
    );
  });

  /**
   * 🔴 下界: **0 件でも文言が空にならない**。1 文を落とすだけで、
   * 「時間をおいて開き直す／管理者へ知らせる」という次の一手は残す。
   */
  it('🔴 応答種別が 0 件でも次の一手は残る', () => {
    const message = staffCallFailureMessage('unreachable', { responsesAvailable: false });
    expect(message).toContain('管理者');
    expect(message).toContain('原因は特定できていません');
  });

  /**
   * 🔴 **他の失敗は応答導線を名指ししていない**（0 件でも文言が変わらないこと）。
   * ここが無いと「全部から 1 文を落とす」変異が素通りする。
   */
  it.each<StaffFailure>(['rejected', 'unavailable'])('🔴 %s の文言は件数に依らない', (f) => {
    expect(staffCallFailureMessage(f, { responsesAvailable: true })).toBe(
      staffCallFailureMessage(f, { responsesAvailable: false }),
    );
  });

  /**
   * 🔴 **通話の文言は、見ている人の回線を疑わせない (#1132)。**
   *
   * `staffCallFailureMessage('unreachable')` に入る経路は 2 つある ——
   * `fetch` の reject（本当に回線が容疑者）と、Vonage の `onError`（**answer API は
   * 200 を返し終えている**ので回線は容疑者ではない）。1 つの文言で両方を賄う以上、
   * **回線を断定してはいけない**。実測では今日 `onError` 側が**常に**発火する
   * （CSP が SDK の CDN 取得を拒否する。#1132 本体）ので、断定は事実上いつも嘘になる。
   *
   * 先例は `src/components/admin/ui/save-outcome.ts` の `unreadable` ——
   * 「通信状態を確かめてください」は**運用者を誤った方向へ調べに行かせる**。
   */
  it('🔴 通話の unreachable は回線のせいにしない', () => {
    // 🔴 応答種別の有無に依らず（#1137 で引数が増えたので両方当てる）。
    for (const m of callMessages('unreachable')) {
      expect(m).not.toContain('通信状態');
      expect(m).not.toContain('ネットワーク');
      // 🔴 下界。回線に触れないだけなら**何も言わない**世界でも満たせる。
      // 原因が分かっていないことと、次の一手があることを併せて縛る。
      expect(m).toContain('原因は特定できていません');
    }
    // 「管理者へ知らせる」は**どちらの世界でも残る**（1 文を落としても次の一手は消えない）。
    for (const m of callMessages('unreachable')) expect(m).toContain('管理者');
    // 🔴 **今日この画面で有効な次の一手を指す。** 同じ画面の `StaffResponseActions` は
    // CSP 由来の失敗なら来訪者へ返答できる（レビュー 3 周目）。
    // 🔴 ただし**断定しない** —— `fetch` reject 経路では応答送信も同じ fetch で必ず失敗する
    // （レビュー 4 周目）。「できます」ではなく「試せます」。
    // 🔴 **指せるのは応答種別が在るときだけ (#1137)。** 0 件の側は上の専用ケースで縛る。
    const withResponses = staffCallFailureMessage('unreachable', { responsesAvailable: true });
    expect(withResponses).toContain('下の応答からの返答も試せます');
    expect(withResponses).not.toContain('返答できます');
  });

  /**
   * 🔴 **応答送信の側は回線に触れてよい（対にしない判断）。**
   *
   * `StaffResponseActions` の catch に入るのは `fetch` の reject だけで、SDK を経由しない。
   * ここまで曖昧にすると、**本当に回線が原因のときに正しい導線を消す**ことになる。
   * 「対を揃える」は目的ではなく、**それぞれの経路で真であること**が目的である。
   */
  it('🔴 応答送信の unreachable は回線に触れてよい（丸めない）', () => {
    const m = staffResponseFailureMessage('unreachable');
    expect(m).toContain('通信状態');
    // 届いたかどうかは断定しない（save-outcome の先例と同じ語彙）。
    expect(m).toContain('分かりません');
  });

  /** 🔴 担当者リンクは未認証で開かれる。設定の内訳を出さない。 */
  it.each(ALL)('🔴 %s の文言が env 名・鍵名を漏らさない', (f) => {
    for (const m of [...callMessages(f), staffResponseFailureMessage(f)]) {
      expect(m).not.toMatch(/SECRET|ADMIN_|KIOSK_|CALL_ANSWER/);
    }
  });
});
