/**
 * QR 受付が実際に呼び出しを行い、結果を正直に伝えること (#736 Gate A)。
 *
 * ## 事実（修正前）
 *
 * `/api/kiosk/checkin/confirm` は受付セッションを作って 201 を返すだけで、
 * **`/api/kiosk/receptions/:id/call` を一度も呼ばなかった**。それでも端末は
 * 「担当者を呼び出しています…」→「受付が完了しました」と表示し、監査には
 * `reception.connected` を書いていた。**誰も呼ばれていないのに全員が受付完了する。**
 *
 * `unrouted`（#738）・`out_of_hours`（#747）で塞いだのと同型の嘘で、しかも
 * QR 経路は**常に**この状態だった。
 */
import { describe, expect, it } from 'vitest';
import { checkinCallOutcomeFrom } from './call-outcome';

describe('checkinCallOutcomeFrom (#736)', () => {
  it('接続できたときだけ完了にする', () => {
    expect(checkinCallOutcomeFrom(200, { state: 'connected' })).toEqual({ kind: 'connected' });
  });

  /**
   * 🔴 **未応答を完了にしない。** 担当者が出なかったのに「受付が完了しました」と出すのが
   * この issue の本体。
   */
  it('🔴 未応答は完了ではない', () => {
    expect(checkinCallOutcomeFrom(200, { state: 'timeout' })).toEqual({
      kind: 'failed',
      reason: 'unanswered',
    });
  });

  it('呼び出しに失敗したら完了ではない', () => {
    expect(checkinCallOutcomeFrom(200, { state: 'failed' })).toEqual({
      kind: 'failed',
      reason: 'server',
    });
  });

  /**
   * 実 PSTN は 1 手撃った時点で結果が無い。**ここで完了にすると、電話が鳴っている最中に
   * 「受付が完了しました」と出す。** サーバの確定を待つ。
   */
  it('🔴 実 PSTN の呼び出し中は保留（完了にしない）', () => {
    expect(checkinCallOutcomeFrom(200, { state: 'calling' })).toEqual({ kind: 'pending' });
  });

  it('🔴 実発信が止まっているときは取り次げないと伝える', () => {
    expect(checkinCallOutcomeFrom(503, { error: 'unrouted' })).toEqual({
      kind: 'failed',
      reason: 'unrouted',
    });
  });

  it('🔴 営業時間外はその理由で伝える（呼び出しは行われていない）', () => {
    expect(checkinCallOutcomeFrom(409, { error: 'out_of_hours' })).toEqual({
      kind: 'failed',
      reason: 'out_of_hours',
    });
  });

  it('端末セッション切れは来訪者の操作では直らないので区別する', () => {
    expect(checkinCallOutcomeFrom(403, {})).toEqual({ kind: 'failed', reason: 'session' });
  });

  it('応答を得られていない（fetch 例外）は通信断', () => {
    expect(checkinCallOutcomeFrom(undefined, undefined)).toEqual({
      kind: 'failed',
      reason: 'network',
    });
  });

  /**
   * 🔴 **知らない状態を完了として扱わない。** 握り潰すと、呼ばれていないのに
   * 来訪者が「受付完了」を見て立ち去る。
   */
  it('🔴 未知の状態は完了にしない', () => {
    expect(checkinCallOutcomeFrom(200, { state: 'TEST-unknown' })).toEqual({
      kind: 'failed',
      reason: 'server',
    });
    expect(checkinCallOutcomeFrom(500, {})).toEqual({ kind: 'failed', reason: 'server' });
  });
});
