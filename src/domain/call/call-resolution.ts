/**
 * 実 PSTN 通話の結果確定 (#647)。
 *
 * ## なぜ必要か
 *
 * 実発信 (#4 Inc D-2 項目 2) では、受付は `'calling'` を返して終わる。webhook が届くと
 * 相関（`StoredCallCorrelation`）の `voiceState` は進むが、**受付の状態を動かす者が居ない**。
 * 結果として来訪者は呼び出し中画面で待ち続ける。ここはその写像を持つ。
 *
 * ## タイムアウトの権威はサーバ (2026-08-08 ユーザー判断)
 *
 * 端末のタイマー（#323）は**段階的ケアの表示**を進めるだけで、状態は確定させない。
 * 状態を決めるのはこの関数＝サーバ側だけ。二重にすると「画面はタイムアウトだが
 * 電話は鳴り続ける」が起こる。
 *
 * ## webhook が一度も来ない場合
 *
 * Vonage 側障害・署名失敗・相関不整合では webhook が届かず、相関は `ringing` のまま止まる。
 * 定期 sweeper（EventBridge）は**継続的な AWS 費用**になるので採らず、`/status` の
 * **読み時に遅延評価**する（ユーザー判断）。端末がポーリングしている間に確定する。
 *
 * 純関数。永続化も HTTP も知らない ── 書き戻しは呼び出し側が行う。
 */
import type { VoiceCallState } from './voice-call-state';

/** 判定に要る分だけの相関ビュー（永続型そのものに依存しない）。 */
export type CallCorrelationView = {
  /** 旧レコードには無い。無ければ `'queued'` 扱い。 */
  readonly voiceState?: VoiceCallState;
  readonly status: 'in_flight' | 'settled';
  /**
   * この発信の呼出予算の期限（ISO）。発信時に `now + step.timeoutSeconds + margin` で置く。
   * **旧レコードには無い。無いことを「期限切れ」と読んではいけない**（鳴っている最中に打ち切る）。
   */
  readonly dialExpiresAt?: string;
};

export type CallResolution =
  /** まだ結果が無い。端末は待ち続けてよい。 */
  | { readonly kind: 'pending' }
  | { readonly kind: 'connected' }
  /** 応答が得られなかった（体験モデルの `person_unavailable`）。 */
  | { readonly kind: 'timeout'; readonly reason?: string }
  /** 発信そのものが失敗した（体験モデルの `contact_failed`）。 */
  | { readonly kind: 'failed'; readonly reason?: string };

/** 通話状態から結果を引く。未確定（呼出中）は undefined。 */
function fromVoiceState(state: VoiceCallState): CallResolution | undefined {
  switch (state) {
    case 'answered':
    case 'staff_coming':
      return { kind: 'connected' };
    case 'no_answer':
    case 'busy':
    // 辞退も来訪者から見れば「応答が得られなかった」。代替導線へ倒す点は未応答と同じ。
    // 次の手（代理・部門代表）への escalation は #646。
    case 'declined':
      return { kind: 'timeout', reason: state };
    case 'failed':
      return { kind: 'failed', reason: 'call_failed' };
    case 'queued':
    case 'ringing':
    case 'awaiting_acceptance':
      return undefined;
  }
}

/** 期限を過ぎているか。**不明・不正はすべて「過ぎていない」**（勝手に打ち切らない）。 */
function budgetElapsed(dialExpiresAt: string | undefined, nowMs: number): boolean {
  if (dialExpiresAt === undefined) return false;
  const expiresAt = Date.parse(dialExpiresAt);
  if (Number.isNaN(expiresAt)) return false;
  return nowMs > expiresAt;
}

/**
 * 相関の現状から受付の結果を決める。
 *
 * 🔴 **通話状態が先、予算は後。** 逆にすると、応答済み（担当者が向かっている）なのに
 * 「時間切れ」で代替導線を出すことになる。
 */
export function resolveCallResolution(
  correlation: CallCorrelationView,
  nowMs: number,
): CallResolution {
  const fromState = fromVoiceState(correlation.voiceState ?? 'queued');
  if (fromState !== undefined) return fromState;

  if (budgetElapsed(correlation.dialExpiresAt, nowMs)) {
    return { kind: 'timeout', reason: 'dial_budget_elapsed' };
  }
  return { kind: 'pending' };
}
