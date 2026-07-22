/**
 * Turn/barge-in 内部イベント → 音声評価ハーネス共通イベント (issue #365) への橋渡し (issue #372)。
 *
 * `docs/voice-evaluation-harness.md` の「#369〜#372 の適合の示し方」に従い、この Turn 実装は
 * `speech.end` / `turn.committed` / `audio.onset` / `tts.playback_stopped(barge_in)` イベントを
 * ここ経由でのみ生成する。適合ゲートは呼び出し側のテストで
 * `validateVoiceEvalSession(session).errors` が空であることを確認する
 * （`evaluation-demo.test.ts` 参照）。
 *
 * `tts.playback_stopped` は #371 (`voice-tts/eval-bridge.ts`) と語彙・関数を共有する
 * （`reason: 'barge_in'` を出すのがこの層の責務）。生成関数自体は重複させず、そちらを再輸出する。
 */
import { ttsPlaybackStoppedEvent } from '@/domain/voice-tts/eval-bridge';
import type { VoiceEvalEvent } from '@/domain/voice/evaluation-events';

import type { VoiceEvalTurnTrigger } from '@/domain/voice/evaluation-events';

const STAGE = 'turn' as const;

/** 発話終了（VAD が音声区間の終わりを検出した時刻）。 */
export function speechEndEvent(t: number, turnIndex = 0): VoiceEvalEvent {
  return { type: 'speech.end', t, turnIndex };
}

/** ターン確定。`text` は確定時点の認識テキスト、`trigger` は `decideTurnEnd` が返した理由。 */
export function turnCommittedEvent(t: number, text: string, trigger: VoiceEvalTurnTrigger, turnIndex = 0): VoiceEvalEvent {
  return { type: 'turn.committed', t, turnIndex, text, trigger };
}

/**
 * 音声区間の開始観測。ユーザー発話の開始にも、TTS 再生中の近端発話（相づち/割り込み/雑音/エコー）
 * の onset にも使う共通イベント —— #365 の設計方針どおり、近端発話専用のイベントは作らず
 * 再生区間中に落ちた `audio.onset` として扱う（`evaluation-events.ts` の
 * `observedNearEndOnsets` が導出する）。
 */
export function audioOnsetEvent(t: number, turnIndex = 0): VoiceEvalEvent {
  return { type: 'audio.onset', t, turnIndex };
}

/** barge-in による再生停止（#371 の関数をそのまま使い、二重定義を避ける）。 */
export function bargeInPlaybackStoppedEvent(t: number, turnIndex = 0): VoiceEvalEvent {
  return ttsPlaybackStoppedEvent(t, 'barge_in', turnIndex);
}

/**
 * Turn 層の列挙可能な短いエラーコード。例外メッセージをそのまま渡さない
 * （PII・内部パス混入防止、評価ハーネスの方針）。
 */
export const VOICE_TURN_ERROR_CODES = [
  'vad_unavailable',
  'classifier_timeout',
  'max_wait_exceeded_without_commit',
  'duck_failed',
  'stop_playback_failed',
] as const;

export type VoiceTurnErrorCode = (typeof VOICE_TURN_ERROR_CODES)[number];

export function turnErrorEvent(t: number, code: VoiceTurnErrorCode, turnIndex = 0): VoiceEvalEvent {
  return { type: 'error', t, turnIndex, stage: STAGE, code };
}

export function turnSessionAbortedEvent(t: number, code: VoiceTurnErrorCode, turnIndex = 0): VoiceEvalEvent {
  return { type: 'session.aborted', t, turnIndex, stage: STAGE, code };
}
