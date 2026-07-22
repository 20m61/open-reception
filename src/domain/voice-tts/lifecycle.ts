/**
 * TTS utterance lifecycle 状態機械 (issue #371)。
 *
 * `src/domain/voice-transport/lifecycle.ts` (#369) と同じ流儀 —— 遷移表 + 純関数。
 * ソケット・タイマー・実音声再生などの I/O は持たない。
 *
 * 設計方針の核心（issue #371 本文）: **Provider 側の生成中止**と**端末側の再生停止・キュー破棄**
 * を別責務にする。ここでは 2 つの独立した状態機械として表現する:
 *
 *  - `TtsGenerationState`: provider からの合成ストリームの進行（`abortGeneration` が動かす）。
 *  - `TtsPlaybackState`: 端末上の再生キューの進行（`stopPlayback`/`discardQueuedAudio` が動かす）。
 *
 * 1 つの utterance は両方の状態を独立に持ちうる（例: 生成は完了済みだが再生はまだ queued）。
 * `isSpeakingMotionActive` は **再生状態だけ**を見る —— TTS 停止時に口パク/speaking motion が
 * 残らないことを保証する唯一の判定点（issue #371 AC）。
 */

// --- 生成 (provider 側) ---

export const TTS_GENERATION_STATES = ['idle', 'requested', 'streaming', 'completed', 'aborted', 'error'] as const;
export type TtsGenerationState = (typeof TTS_GENERATION_STATES)[number];

export type TtsGenerationEvent =
  | { type: 'REQUEST' }
  | { type: 'FIRST_CHUNK' }
  | { type: 'CHUNK' }
  | { type: 'COMPLETE' }
  | { type: 'ABORT' }
  | { type: 'ERROR' };

type GenerationEventType = TtsGenerationEvent['type'];

const GENERATION_TERMINAL: ReadonlySet<TtsGenerationState> = new Set(['completed', 'aborted', 'error']);

const GENERATION_TRANSITIONS: Partial<Record<TtsGenerationState, Partial<Record<GenerationEventType, TtsGenerationState>>>> = {
  idle: { REQUEST: 'requested' },
  requested: { FIRST_CHUNK: 'streaming', COMPLETE: 'completed', ABORT: 'aborted', ERROR: 'error' },
  streaming: { CHUNK: 'streaming', COMPLETE: 'completed', ABORT: 'aborted', ERROR: 'error' },
};

/** 生成状態を遷移させる。終端状態（completed/aborted/error）は吸収状態 —— 以後は無視する。 */
export function transitionGeneration(state: TtsGenerationState, event: TtsGenerationEvent): TtsGenerationState {
  if (GENERATION_TERMINAL.has(state)) return state;
  return GENERATION_TRANSITIONS[state]?.[event.type] ?? state;
}

// --- 再生 (端末側) ---

export const TTS_PLAYBACK_STATES = ['idle', 'queued', 'playing', 'stopped', 'discarded', 'completed'] as const;
export type TtsPlaybackState = (typeof TTS_PLAYBACK_STATES)[number];

export type TtsPlaybackEvent =
  | { type: 'ENQUEUE' }
  | { type: 'START' }
  /** 現在再生中の音声を即時停止する（barge-in 等）。discardQueuedAudio とは別責務。 */
  | { type: 'STOP' }
  /** まだ再生されていないキュー内音声を破棄する。再生中の音声には触れない（別責務）。 */
  | { type: 'DISCARD' }
  | { type: 'COMPLETE' };

type PlaybackEventType = TtsPlaybackEvent['type'];

const PLAYBACK_TERMINAL: ReadonlySet<TtsPlaybackState> = new Set(['stopped', 'discarded', 'completed']);

const PLAYBACK_TRANSITIONS: Partial<Record<TtsPlaybackState, Partial<Record<PlaybackEventType, TtsPlaybackState>>>> = {
  idle: { ENQUEUE: 'queued' },
  queued: { START: 'playing', DISCARD: 'discarded' },
  playing: { STOP: 'stopped', COMPLETE: 'completed' },
};

/**
 * 再生状態を遷移させる。終端状態（stopped/discarded/completed）は吸収状態 ——
 * 古い START が紛れ込んでも再生が再開しない（issue #371 AC の安全側の保証）。
 *
 * `DISCARD` は `queued` からのみ有効（再生中の音声を破棄したい場合は `STOP` を使う —— 別責務）。
 */
export function transitionPlayback(state: TtsPlaybackState, event: TtsPlaybackEvent): TtsPlaybackState {
  if (PLAYBACK_TERMINAL.has(state)) return state;
  return PLAYBACK_TRANSITIONS[state]?.[event.type] ?? state;
}

/**
 * 口パク/speaking motion を出してよいか。`playing` のときだけ true。
 *
 * 現行 VRM viewer（`src/components/kiosk/VrmAvatarViewer.tsx`、このモジュールは触らない）の
 * 接続点は `speaking: boolean` prop であり、この関数の戻り値がその prop に対応する
 * （配線自体は次周回、`docs/adr/0002-voice-tts-cache-boundaries.md` 参照）。
 */
export function isSpeakingMotionActive(playbackState: TtsPlaybackState): boolean {
  return playbackState === 'playing';
}
