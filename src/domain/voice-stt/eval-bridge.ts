/**
 * STT/Entity 内部イベント → 音声評価ハーネス共通イベント (issue #365) への橋渡し (issue #370)。
 *
 * `docs/voice-evaluation-harness.md` の「#369〜#372 の適合の示し方」に従い、この STT 実装は
 * `stt.*` / `entity.resolved` イベントをここ経由でのみ生成する。適合ゲートは呼び出し側のテストで
 * `validateVoiceEvalSession(session).errors` が空であることを確認する（`eval-bridge.test.ts` 参照）。
 *
 * `entity.resolved` の `candidates` は score 降順である必要がある（バリデータが強制する）。
 * `entity-resolver.ts` の `resolveEntities`/`resolveStaffEntities`/`resolveDepartmentEntities` は
 * 既に降順で返すため、ここでは並べ替えず素通しする（呼び出し側が独自に候補を組み立てる場合は
 * 呼び出し側の責任で降順を保つこと）。
 */
import type { VoiceEvalEvent } from '@/domain/voice/evaluation-events';
import type { EntityCandidate } from './entity-resolver';
import type { FinalTranscript, PartialTranscript } from './types';

export function sttPartialEvent(partial: PartialTranscript, turnIndex = 0): VoiceEvalEvent {
  return { type: 'stt.partial', t: partial.t, turnIndex, text: partial.text, stable: partial.stable };
}

export function sttFinalEvent(final: FinalTranscript, turnIndex = 0): VoiceEvalEvent {
  return { type: 'stt.final', t: final.t, turnIndex, text: final.text };
}

export function entityResolvedEvent(
  t: number,
  query: string,
  candidates: readonly EntityCandidate[],
  turnIndex = 0,
): VoiceEvalEvent {
  return {
    type: 'entity.resolved',
    t,
    turnIndex,
    query,
    candidates: candidates.map((c) => ({ id: c.id, kind: c.kind, score: c.entityConfidence })),
  };
}

/**
 * STT 層の列挙可能な短いエラーコード。例外メッセージをそのまま渡さない
 * （PII・内部パス混入防止、評価ハーネスの方針）。`fallback.ts` の
 * `VOICE_STT_FALLBACK_REASONS` と対応させやすいよう語彙を揃える。
 */
export const VOICE_STT_ERROR_CODES = [
  'stream_error',
  'provider_unavailable',
  'decode_error',
  'timeout',
  'rate_limited',
  'reconnect_exhausted',
] as const;

export type VoiceSttErrorCode = (typeof VOICE_STT_ERROR_CODES)[number];

export function sttErrorEvent(t: number, code: VoiceSttErrorCode, turnIndex = 0): VoiceEvalEvent {
  return { type: 'error', t, turnIndex, stage: 'stt', code };
}

export function sttSessionAbortedEvent(t: number, code: VoiceSttErrorCode, turnIndex = 0): VoiceEvalEvent {
  return { type: 'session.aborted', t, turnIndex, stage: 'stt', code };
}
