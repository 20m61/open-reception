/**
 * QR 受付の呼び出し結果 → 来訪者へ伝えること (#736 Gate A)。
 *
 * ## なぜ要るのか
 *
 * `/api/kiosk/checkin/confirm` は受付セッションを作って 201 を返すだけで、
 * **`/api/kiosk/receptions/:id/call` を一度も呼んでいなかった**。それでも端末は
 * 「担当者を呼び出しています…」→「受付が完了しました」と表示し、監査には
 * `reception.connected` を書いていた。**誰も呼ばれていないのに全員が受付完了する。**
 *
 * `unrouted`（#738）・`out_of_hours`（#747）で塞いだのと同型の嘘。違いは、あちらが
 * 特定の運用状態でだけ起きたのに対し、**QR 経路は常にこの状態だった**こと。
 *
 * 判断はここに集約する。`CheckinFlow` の中に手書きで散らすと、
 * `KioskFlow` で起きたのと同じこと（サーバが新しい理由を返しても端末が黙って潰す）になる。
 */
import type { CheckinCallFailureReason } from './failure';

export type CheckinCallOutcome =
  /** 担当者へ繋がった。ここだけが「受付完了」。 */
  | { readonly kind: 'connected' }
  /**
   * 実 PSTN は 1 手撃った時点では結果が無い（webhook で後から届く）。
   * **完了にしない。** サーバ側の確定を `/status` の読みで待つ。
   */
  | { readonly kind: 'pending' }
  | { readonly kind: 'failed'; readonly reason: CheckinCallFailureReason };

type CallResponse = { readonly state?: string; readonly error?: string };

/**
 * 呼び出し API の応答から、来訪者へ何を伝えるかを決める。
 * `status` 未指定 = fetch が例外（応答を得られていない）。
 *
 * 🔴 **知らない状態・知らない理由を「完了」として扱わない。** 握り潰すと、
 * 呼ばれていないのに来訪者が受付完了を見て立ち去る。
 */
export function checkinCallOutcomeFrom(
  status: number | undefined,
  body: CallResponse | undefined,
): CheckinCallOutcome {
  if (status === undefined) return { kind: 'failed', reason: 'network' };
  if (status === 403) return { kind: 'failed', reason: 'session' };

  // サーバが理由を名指ししているならそれを優先する（状態より具体的）。
  const error = body?.error;
  if (error === 'unrouted') return { kind: 'failed', reason: 'unrouted' };
  if (error === 'out_of_hours') return { kind: 'failed', reason: 'out_of_hours' };
  if (error === 'invalid') return { kind: 'failed', reason: 'invalid' };
  if (status === 503) return { kind: 'failed', reason: 'network' };
  if (status >= 400) return { kind: 'failed', reason: 'server' };

  switch (body?.state) {
    case 'connected':
      return { kind: 'connected' };
    case 'calling':
      return { kind: 'pending' };
    case 'timeout':
      // 「呼び出しに失敗した」ではない ── 呼び出しは行われ、相手が出なかった。
      return { kind: 'failed', reason: 'unanswered' };
    default:
      return { kind: 'failed', reason: 'server' };
  }
}
