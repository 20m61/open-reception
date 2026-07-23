/**
 * STT 障害/準備不能時にタッチ・文字入力へ切り替えるためのフォールバックイベント (issue #370)。
 *
 * `src/domain/voice-transport/fallback.ts`（issue #369）と同じ中立イベント形に揃える —
 * Kiosk 側は Transport と STT のどちらの `*FallbackRequired` イベントも同じ形で購読でき、
 * `useFallback` アクションへ変換すればよい（UI 配線は他トラック・スコープ外）。
 */

export const VOICE_STT_FALLBACK_REASONS = [
  'stream_error',
  'provider_unavailable',
  'reconnect_exhausted',
  'no_partial_timeout',
] as const;

export type VoiceSttFallbackReason = (typeof VOICE_STT_FALLBACK_REASONS)[number];

export type VoiceSttFallbackEvent = {
  type: 'voiceSttFallbackRequired';
  reason: VoiceSttFallbackReason;
  /** セッション開始からの相対 ms（評価ハーネスと同じ単一時計源を想定）。 */
  t: number;
};

/**
 * STT のエラーコード（`eval-bridge.ts` の `VoiceSttErrorCode` 相当）からフォールバック
 * イベントを作る。未知のコードは `provider_unavailable` として防御的に扱う（呼び出し側の
 * 分岐漏れで fallback を出し忘れるより安全側に倒す）。
 */
export function fallbackEventForSttError(code: string, t: number): VoiceSttFallbackEvent {
  const reason = (VOICE_STT_FALLBACK_REASONS as readonly string[]).includes(code)
    ? (code as VoiceSttFallbackReason)
    : 'provider_unavailable';
  return { type: 'voiceSttFallbackRequired', reason, t };
}

/** STT session の実効ステータス（provider 実装が報告する健全性）。 */
export type VoiceSttStatus = 'active' | 'stalled' | 'closed_unexpectedly';

/**
 * session の状態からフォールバック要否を導く。`active` は null（フォールバック不要）。
 * `stalled` は partial/final が一定時間来ない状態、`closed_unexpectedly` は明示 close 以外で
 * ストリームが終わった状態を表す（呼び出し側のタイムアウト監視・onclose ハンドラが判定する）。
 */
export function fallbackEventForSttStatus(status: VoiceSttStatus, t: number): VoiceSttFallbackEvent | null {
  if (status === 'active') return null;
  if (status === 'stalled') return { type: 'voiceSttFallbackRequired', reason: 'no_partial_timeout', t };
  return { type: 'voiceSttFallbackRequired', reason: 'provider_unavailable', t };
}
