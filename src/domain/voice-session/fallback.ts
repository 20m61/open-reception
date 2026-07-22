/**
 * 4 層（transport/stt/tts/turn）のフォールバック/障害表現を、単一の `VoiceSessionFallbackEvent`
 * へ正規化する純関数 (issue #364 統合)。
 *
 * 各層は独立して開発された（#369〜#372）ため、フォールバックの表現も層ごとに異なる形をしている
 * （`VoiceTransportFallbackEvent`/`VoiceSttFallbackEvent` は名前付きイベント、TTS は
 * `TtsFailureReason`(常に継続可能、caption_only が最終防御線)、Turn は列挙エラーコード）。
 * Kiosk 側が「音声基盤が使えないのでタッチへ切り替える」判断を層ごとに書き分けずに済むよう、
 * ここで語彙を揃える —— `reason` には元の層の理由コードをそのまま保持し、診断可能性は失わない。
 */
import type { VoiceTransportFallbackEvent } from '@/domain/voice-transport/fallback';
import type { VoiceSttFallbackEvent } from '@/domain/voice-stt/fallback';
import type { TtsFailureReason } from '@/domain/voice-tts/fallback';
import type { VoiceTurnErrorCode } from '@/domain/voice-turn/eval-bridge';
import type { VoiceSessionFallbackEvent } from './types';

/** Transport (#369) のフォールバックイベントを正規化する。 */
export function normalizeTransportFallback(event: VoiceTransportFallbackEvent): VoiceSessionFallbackEvent {
  return { type: 'voiceSessionFallbackRequired', source: 'transport', reason: event.reason, t: event.t };
}

/** STT (#370) のフォールバックイベントを正規化する。 */
export function normalizeSttFallback(event: VoiceSttFallbackEvent): VoiceSessionFallbackEvent {
  return { type: 'voiceSessionFallbackRequired', source: 'stt', reason: event.reason, t: event.t };
}

/**
 * TTS (#371) の障害理由を正規化する。TTS は常にキャッシュ/字幕フォールバックで受付を継続できる
 * （`decideTtsFallback`）ため、このイベント自体は「タッチへの強制切替」を意味しない —— 診断・
 * 監視用のシグナルとして、他層と同じ形で観測できるようにするだけ。
 */
export function normalizeTtsFallback(reason: TtsFailureReason, t: number): VoiceSessionFallbackEvent {
  return { type: 'voiceSessionFallbackRequired', source: 'tts', reason, t };
}

/** Turn/barge-in (#372) の列挙エラーコードを正規化する。 */
export function normalizeTurnFallback(code: VoiceTurnErrorCode, t: number): VoiceSessionFallbackEvent {
  return { type: 'voiceSessionFallbackRequired', source: 'turn', reason: code, t };
}
