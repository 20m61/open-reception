/**
 * Transport 障害/未準備時にタッチ受付へ切り替えるためのフォールバックイベント (issue #369)。
 *
 * 設計方針: 本モジュールは Kiosk 側の UI 状態機械（`src/domain/reception/ui-contract.ts`）に
 * 依存しない — あちらは他トラック占有かつ配線はオーケストレータが後続 increment で行う
 * （`docs/loop-queue.md` #369〜#372 の注記）。ここでは Kiosk 側が購読できる**中立なイベント形**
 * だけを定義し、消費側は `useFallback` アクション（`RECEPTION_ACTIONS`）へ変換すればよい。
 */
import type { VoiceTransportLifecycleState } from './lifecycle';
import { isFallbackRequired } from './lifecycle';

export const VOICE_TRANSPORT_FALLBACK_REASONS = [
  'reconnect_exhausted',
  'runtime_stopped',
  'runtime_preparing',
  'runtime_degraded',
] as const;

export type VoiceTransportFallbackReason = (typeof VOICE_TRANSPORT_FALLBACK_REASONS)[number];

export type VoiceTransportFallbackEvent = {
  type: 'voiceTransportFallbackRequired';
  reason: VoiceTransportFallbackReason;
  /** セッション開始からの相対 ms（評価ハーネスと同じ単一時計源を想定）。 */
  t: number;
};

/**
 * lifecycle の状態遷移からフォールバック要否を導く。`degraded`（再接続試行を使い果たした）
 * のときだけイベントを返す。`closed` 単体はフォールバックを含意しない（意図的な close の
 * 可能性があるため）。
 */
export function fallbackEventForLifecycle(
  state: VoiceTransportLifecycleState,
  t: number,
): VoiceTransportFallbackEvent | null {
  if (!isFallbackRequired(state)) return null;
  return { type: 'voiceTransportFallbackRequired', reason: 'reconnect_exhausted', t };
}

/** 会話ランタイム（STT/TTS/ターン制御を提供するバックエンド）自体の実効ステータス。 */
export type VoiceTransportRuntimeStatus = 'ready' | 'preparing' | 'stopped' | 'degraded';

/**
 * runtime 停止・準備中・degraded を Kiosk へフォールバックイベントとして伝える。
 * `ready` のときは null。issue #369「runtime停止・準備中・degraded時のfallbackイベント」。
 */
export function fallbackEventForRuntimeStatus(
  status: VoiceTransportRuntimeStatus,
  t: number,
): VoiceTransportFallbackEvent | null {
  if (status === 'ready') return null;
  return { type: 'voiceTransportFallbackRequired', reason: `runtime_${status}`, t };
}
