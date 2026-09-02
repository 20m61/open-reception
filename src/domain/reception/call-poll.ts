/**
 * 呼び出し中のポーリング判断 (#647)。
 *
 * 実 PSTN 発信の受付は `'calling'` で返り、結果は provider webhook 経由で
 * `/api/kiosk/receptions/:id/status` に現れる（サーバ側の遅延確定）。端末はそれを
 * 取りに行く必要がある。ここは**いつ止めて何を dispatch するか**だけを持つ純関数。
 *
 * ## 権威はサーバ (2026-08-08 ユーザー判断)
 *
 * 🔴 **経過時間で結果を作らない。** 端末のタイマー（#323）は段階的ケアの表示を進めるだけ。
 * 状態を決めるのはサーバの応答だけで、ここが返す `resolved` は
 * 「サーバがそう言った」以上の意味を持たない。
 *
 * `give_up` は**結果の判定ではない** ── 「判定できなかった」ことの表明で、
 * 体験モデルの `contact_failed`（呼び出しを完了できなかった）へ倒す。未応答
 * （`person_unavailable`）と混同しないこと。
 */

/** ポーリング間隔。短いと Lambda 呼び出しが増え、長いと来訪者の体感が悪い。 */
export const CALL_STATUS_POLL_INTERVAL_MS = 3_000;

/**
 * ポーリングの上限。サーバ側の呼出予算（step timeout + 余裕 30 秒）で通常は確定するので、
 * ここへ到達するのは相関を引けない等の異常時だけ。**無限再試行を避ける**ための最後の砦
 * （`docs/experience/README.md`「無限再試行や沈黙を避ける」）。
 */
export const CALL_STATUS_POLL_MAX_MS = 5 * 60_000;

export type PollAction =
  /** まだ確定していない。次の間隔で再取得する。 */
  | { readonly kind: 'wait' }
  | {
      readonly kind: 'resolved';
      readonly event: 'CALL_CONNECTED' | 'CALL_TIMEOUT' | 'CALL_FAILED';
    }
  /** 判定できなかった。代替導線へ倒す（結果を断定しない）。 */
  | { readonly kind: 'give_up' };

/**
 * サーバが返した受付状態と経過時間から、次の行動を決める。
 *
 * 🔴 **サーバの結果を経過時間で上書きしない。** 上限判定を先に置くと、確定済みの応答が
 * 「時間切れ」に潰されて、担当者が向かっているのに代替導線を出すことになる。
 */
export function decidePollAction(state: string, elapsedMs: number): PollAction {
  switch (state) {
    case 'connected':
      return { kind: 'resolved', event: 'CALL_CONNECTED' };
    case 'timeout':
      return { kind: 'resolved', event: 'CALL_TIMEOUT' };
    case 'failed':
      return { kind: 'resolved', event: 'CALL_FAILED' };
    case 'calling':
      return elapsedMs > CALL_STATUS_POLL_MAX_MS ? { kind: 'give_up' } : { kind: 'wait' };
    default:
      // cancelled / completed 等へ外部要因で移った場合、待ち続けても意味が無い。
      return { kind: 'give_up' };
  }
}
