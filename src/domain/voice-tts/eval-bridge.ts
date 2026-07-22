/**
 * TTS 内部イベント → 音声評価ハーネス共通イベント (issue #365) への橋渡し (issue #371)。
 *
 * `docs/voice-evaluation-harness.md` の「#369〜#372 の適合の示し方」に従い、この TTS 実装は
 * `tts.*` / `vrm.viseme_applied` イベントをここ経由でのみ生成する。適合ゲートは呼び出し側の
 * テストで `validateVoiceEvalSession(session).errors` が空であることを確認する
 * （本ファイルの `eval-bridge.test.ts` 参照）。
 *
 * issue #371 が出力を求める 4 指標のマッピング:
 *   - first-byte  → `ttsFirstByteEvent`（`tts.first_byte`）
 *   - first-audio → `ttsPlaybackStartEvent`（`tts.playback_start`）
 *   - completion  → `ttsPlaybackStoppedEvent(t, 'completed')`（`tts.playback_stopped`）
 *   - viseme timing → `vrmVisemeAppliedEvent`（`vrm.viseme_applied.audioTimestampMs`）
 *
 * `error` / `session.aborted` の `code` は列挙可能な短い識別子に限る（評価ハーネス側の
 * バリデータが 64 文字超・例外メッセージ丸ごとの混入を拒否する）。
 */
import type { VoiceEvalEvent, VoiceEvalPlaybackStopReason, VoiceEvalStage } from '@/domain/voice/evaluation-events';

const STAGE: VoiceEvalStage = 'tts';

export function ttsRequestEvent(t: number, text: string, turnIndex = 0): VoiceEvalEvent {
  return { type: 'tts.request', t, turnIndex, text };
}

export function ttsFirstByteEvent(t: number, turnIndex = 0): VoiceEvalEvent {
  return { type: 'tts.first_byte', t, turnIndex };
}

export function ttsPlaybackStartEvent(t: number, turnIndex = 0): VoiceEvalEvent {
  return { type: 'tts.playback_start', t, turnIndex };
}

export function ttsPlaybackStoppedEvent(t: number, reason: VoiceEvalPlaybackStopReason, turnIndex = 0): VoiceEvalEvent {
  return { type: 'tts.playback_stopped', t, turnIndex, reason };
}

export function vrmVisemeAppliedEvent(t: number, audioTimestampMs: number, turnIndex = 0): VoiceEvalEvent {
  return { type: 'vrm.viseme_applied', t, turnIndex, audioTimestampMs };
}

/** TTS 層の列挙可能な短いエラーコード。例外メッセージをそのまま渡さない（PII・内部パス混入防止）。 */
export const TTS_ERROR_CODES = [
  'provider_error',
  'provider_timeout',
  'provider_quota_exceeded',
  'cache_miss_and_provider_unavailable',
  'playback_error',
  'abort_failed',
] as const;

export type TtsErrorCode = (typeof TTS_ERROR_CODES)[number];

export function ttsErrorEvent(t: number, code: TtsErrorCode, turnIndex = 0): VoiceEvalEvent {
  return { type: 'error', t, turnIndex, stage: STAGE, code };
}

export function ttsSessionAbortedEvent(t: number, code: TtsErrorCode, turnIndex = 0): VoiceEvalEvent {
  return { type: 'session.aborted', t, turnIndex, stage: STAGE, code };
}
