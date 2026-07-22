/**
 * Transport 内部イベント → 音声評価ハーネス共通イベント (issue #365) への橋渡し (issue #369)。
 *
 * `docs/voice-evaluation-harness.md` の「#369〜#372 の適合の示し方」に従い、この Transport
 * 実装は `transport.*` イベントをここ経由でのみ生成する。適合ゲートは呼び出し側のテストで
 * `validateVoiceEvalSession(session).errors` が空であることを確認する（本ファイルの
 * `eval-bridge.test.ts` 参照）。
 *
 * `error` / `session.aborted` の `code` は列挙可能な短い識別子に限る（評価ハーネス側の
 * バリデータが 64 文字超・例外メッセージ丸ごとの混入を拒否する）。
 */
import type { VoiceEvalEvent, VoiceEvalStage } from '@/domain/voice/evaluation-events';
import type { VoiceTransportDisconnectReason } from './lifecycle';

const STAGE: VoiceEvalStage = 'transport';

export function transportConnectedEvent(t: number, turnIndex = 0): VoiceEvalEvent {
  return { type: 'transport.connected', t, turnIndex };
}

export function transportStreamOpenEvent(t: number, turnIndex = 0): VoiceEvalEvent {
  return { type: 'transport.stream_open', t, turnIndex };
}

export function transportReconnectingEvent(t: number, attempt: number, turnIndex = 0): VoiceEvalEvent {
  return { type: 'transport.reconnecting', t, turnIndex, attempt };
}

export function transportDisconnectedEvent(
  t: number,
  reason: VoiceTransportDisconnectReason,
  turnIndex = 0,
): VoiceEvalEvent {
  return { type: 'transport.disconnected', t, turnIndex, reason };
}

export function transportStatsEvent(
  t: number,
  stats: { droppedPackets: number; jitterMs: number },
  turnIndex = 0,
): VoiceEvalEvent {
  return { type: 'transport.stats', t, turnIndex, droppedPackets: stats.droppedPackets, jitterMs: stats.jitterMs };
}

/**
 * Transport 層の列挙可能な短いエラーコード。例外メッセージをそのまま渡さない
 * （PII・内部パス混入防止, 評価ハーネスの方針）。
 */
export const VOICE_TRANSPORT_ERROR_CODES = [
  'token_rejected',
  'token_expired',
  'token_replayed',
  'tenant_mismatch',
  'site_mismatch',
  'kiosk_mismatch',
  'reception_mismatch',
  'queue_overflow',
  'rate_limited',
  'socket_error',
  'reconnect_exhausted',
  'concurrency_limit',
  'chunk_too_large',
] as const;

export type VoiceTransportErrorCode = (typeof VOICE_TRANSPORT_ERROR_CODES)[number];

export function transportErrorEvent(t: number, code: VoiceTransportErrorCode, turnIndex = 0): VoiceEvalEvent {
  return { type: 'error', t, turnIndex, stage: STAGE, code };
}

export function transportSessionAbortedEvent(t: number, code: VoiceTransportErrorCode, turnIndex = 0): VoiceEvalEvent {
  return { type: 'session.aborted', t, turnIndex, stage: STAGE, code };
}
