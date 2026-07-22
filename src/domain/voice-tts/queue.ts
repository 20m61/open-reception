/**
 * utterance 単位の再生キュー (端末側, issue #371)。
 *
 * `src/domain/voice-transport/queue.ts`（#369, バイト単位の有界送信キュー）とは別物 ——
 * こちらは utterance（1 発話）単位の順序管理と `TtsPlaybackState`（`lifecycle.ts`）を組み合わせた
 * 純粋な reducer。実バイト列・実タイマー・実 <audio> 再生は `src/lib/voice-tts/` が持つ。
 */
import { transitionPlayback, type TtsPlaybackState } from './lifecycle';

type TtsQueueEntry = {
  utteranceId: string;
  playbackState: TtsPlaybackState;
  /**
   * duck 中か（issue #371 追加 / #372 barge-in の申し送り）。`playbackState` とは**独立**の
   * 軸として持つ —— duck は「再生中の音量を下げて継続する」ことであり、lifecycle 上の
   * 状態遷移（`transitionPlayback`）ではない（停止/破棄/完了とは別責務）。`playing` の
   * utterance にのみ意味を持つ（`isSpeakingMotionActive` は `playbackState` だけを見るため、
   * ducked 中も speaking motion は継続する —— 停止ではなく減衰）。
   */
  ducked: boolean;
};

export type TtsPlaybackQueueState = {
  entries: readonly TtsQueueEntry[];
};

export function emptyTtsPlaybackQueueState(): TtsPlaybackQueueState {
  return { entries: [] };
}

function findEntry(state: TtsPlaybackQueueState, utteranceId: string): TtsQueueEntry | undefined {
  return state.entries.find((e) => e.utteranceId === utteranceId);
}

function mapEntry(
  state: TtsPlaybackQueueState,
  utteranceId: string,
  fn: (entry: TtsQueueEntry) => TtsQueueEntry,
): TtsPlaybackQueueState {
  const entry = findEntry(state, utteranceId);
  if (!entry) return state; // 未知の utteranceId は no-op（issue #371: 既に破棄済み等への冪等性）。
  return {
    entries: state.entries.map((e) => (e.utteranceId === utteranceId ? fn(e) : e)),
  };
}

/** utterance をキューへ積む。既に存在する場合は冪等（二重 enqueue を無視する）。 */
export function enqueueUtterance(state: TtsPlaybackQueueState, utteranceId: string): TtsPlaybackQueueState {
  if (findEntry(state, utteranceId)) return state;
  return {
    entries: [...state.entries, { utteranceId, playbackState: transitionPlayback('idle', { type: 'ENQUEUE' }), ducked: false }],
  };
}

/** 指定 utterance の再生を開始する（queued → playing）。 */
export function startPlayback(state: TtsPlaybackQueueState, utteranceId: string): TtsPlaybackQueueState {
  return mapEntry(state, utteranceId, (e) => ({ ...e, playbackState: transitionPlayback(e.playbackState, { type: 'START' }), ducked: false }));
}

/**
 * 現在再生中の utterance を即時停止する（playing → stopped）。`discardQueuedAudio` とは別責務
 * —— こちらは「今鳴っている音」を止める。停止後に ducked が残らないよう合わせてクリアする
 * （issue #371 追加: duck は playbackState と独立の軸だが、終端状態で意味を持たない値を残さない）。
 */
export function stopPlayback(state: TtsPlaybackQueueState, utteranceId: string): TtsPlaybackQueueState {
  return mapEntry(state, utteranceId, (e) => ({ ...e, playbackState: transitionPlayback(e.playbackState, { type: 'STOP' }), ducked: false }));
}

/**
 * まだ再生されていないキュー内音声を破棄する（queued → discarded）。再生中の utterance には
 * 効かない（`lifecycle.ts` の遷移表が queued からのみ DISCARD を許可するため no-op になる）。
 */
export function discardQueuedAudio(state: TtsPlaybackQueueState, utteranceId: string): TtsPlaybackQueueState {
  return mapEntry(state, utteranceId, (e) => ({ ...e, playbackState: transitionPlayback(e.playbackState, { type: 'DISCARD' }), ducked: false }));
}

/** 再生が最後まで完了した（playing → completed）。 */
export function completePlayback(state: TtsPlaybackQueueState, utteranceId: string): TtsPlaybackQueueState {
  return mapEntry(state, utteranceId, (e) => ({ ...e, playbackState: transitionPlayback(e.playbackState, { type: 'COMPLETE' }), ducked: false }));
}

/**
 * 再生音量を下げて発話の継続を見極める（issue #371 追加、#372 `TtsBargeInPort.duck` の実装対象）。
 * `playing` の utterance にのみ効く（まだ鳴っていない/既に終端の utterance を duck する意味が
 * ないため、それ以外は no-op）。`playbackState` 自体は変えない —— duck は停止ではない。
 */
export function duckPlayback(state: TtsPlaybackQueueState, utteranceId: string): TtsPlaybackQueueState {
  return mapEntry(state, utteranceId, (e) => (e.playbackState === 'playing' ? { ...e, ducked: true } : e));
}

/** duck を解除して通常音量へ戻す（issue #371 追加、#372 `TtsBargeInPort.resume` の実装対象）。 */
export function resumePlayback(state: TtsPlaybackQueueState, utteranceId: string): TtsPlaybackQueueState {
  return mapEntry(state, utteranceId, (e) => ({ ...e, ducked: false }));
}

/** 指定 utterance が現在 duck 中か。未知の utteranceId は false。 */
export function isDucked(state: TtsPlaybackQueueState, utteranceId: string): boolean {
  return findEntry(state, utteranceId)?.ducked ?? false;
}

/** 現在 `playing` 状態にある utteranceId（最大 1 件）。無ければ null。 */
export function activeUtteranceId(state: TtsPlaybackQueueState): string | null {
  return state.entries.find((e) => e.playbackState === 'playing')?.utteranceId ?? null;
}

/** まだ再生されていない（`queued`）utteranceId を順序どおりに返す。 */
export function pendingUtteranceIds(state: TtsPlaybackQueueState): string[] {
  return state.entries.filter((e) => e.playbackState === 'queued').map((e) => e.utteranceId);
}

/** 指定 utterance の現在の再生状態。未知の utteranceId は undefined。 */
export function playbackStateOf(state: TtsPlaybackQueueState, utteranceId: string): TtsPlaybackState | undefined {
  return findEntry(state, utteranceId)?.playbackState;
}
