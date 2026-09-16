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
    expect(staffCallFailureMessage(f).trim().length).toBeGreaterThan(0);
    expect(staffResponseFailureMessage(f).trim().length).toBeGreaterThan(0);
  });

  it('原因ごとに文言が全部違う（2 つが同じなら区別した意味がない）', () => {
    expect(new Set(ALL.map(staffCallFailureMessage)).size).toBe(ALL.length);
    expect(new Set(ALL.map(staffResponseFailureMessage)).size).toBe(ALL.length);
  });

  /** 🔴 rejected 以外で「リンク」のせいにしない。 */
  it.each<StaffFailure>(['unavailable', 'unreachable'])('🔴 %s の文言がリンクのせいにしない', (f) => {
    expect(staffCallFailureMessage(f)).not.toContain('リンク');
    expect(staffResponseFailureMessage(f)).not.toContain('リンク');
  });

  /** 🔴 下界。rejected では従来どおりリンク切れの可能性を伝える（全部を曖昧にしない）。 */
  it('🔴 rejected ではリンク切れの可能性を伝える（下界）', () => {
    expect(staffCallFailureMessage('rejected')).toContain('リンク');
    expect(staffResponseFailureMessage('rejected')).toContain('リンク');
  });

  /** 🔴 担当者リンクは未認証で開かれる。設定の内訳を出さない。 */
  it.each(ALL)('🔴 %s の文言が env 名・鍵名を漏らさない', (f) => {
    for (const m of [staffCallFailureMessage(f), staffResponseFailureMessage(f)]) {
      expect(m).not.toMatch(/SECRET|ADMIN_|KIOSK_|CALL_ANSWER/);
    }
  });
});
