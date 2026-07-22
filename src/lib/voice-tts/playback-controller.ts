/**
 * `TtsPlaybackController` の実装 (issue #371 契約案)。
 *
 * `src/domain/voice-tts/queue.ts`（utterance 単位の再生キュー reducer）と `lifecycle.ts`
 * （`isSpeakingMotionActive`）を駆動し、状態変化を中立イベント（`viseme.ts` の
 * `TtsSpeakingTimelineEvent`/`TtsVisemeEvent`）と #365 計測イベントへ橋渡しする。
 *
 * **停止時に口パク/speaking motion が残らないこと**（issue #371 AC）を、状態遷移と同期して
 * 呼び出す `onSpeakingChanged`/`onViseme` コールバックで保証する —— `stopPlayback` /
 * `discardQueuedAudio` / `completePlayback` のいずれの経路でも、再生中でなくなった utterance は
 * 即座に `speaking: false` と `viseme: 'sil'` を発行する。
 *
 * 実 <audio>/AudioContext 再生・実タイマーは持たない（interface + mock、issue #371 運用制約）。
 * 呼び出し側（将来の kiosk 配線）が実チャンクのデコード・再生を担い、このコントローラは
 * utterance の状態遷移と副作用イベントの発行だけを担当する。
 *
 * `duck`/`resume`（issue #371 追加、第 5 wave #372 の申し送り）: `src/domain/voice-turn/
 * barge-in-controller.ts` の `TtsBargeInPort` をこのクラスがそのまま実装できるようにする。
 * duck は「音量を下げて再生を継続する」ことであり停止ではない —— `playbackState` は変えない
 * （`domain/voice-tts/queue.ts` の `duckPlayback`/`resumePlayback`）ため、speaking motion/viseme
 * の通知は発火しない。停止時に口パクが残らない不変条件と同様、duck 中に motion が途切れない
 * 不変条件をここで保証する。
 */
import {
  emptyTtsPlaybackQueueState,
  enqueueUtterance,
  startPlayback as queueStartPlayback,
  stopPlayback as queueStopPlayback,
  discardQueuedAudio as queueDiscardQueuedAudio,
  completePlayback as queueCompletePlayback,
  duckPlayback as queueDuckPlayback,
  resumePlayback as queueResumePlayback,
  isDucked as queueIsDucked,
  activeUtteranceId,
  pendingUtteranceIds as queuePendingUtteranceIds,
  playbackStateOf,
  type TtsPlaybackQueueState,
} from '@/domain/voice-tts/queue';
import { isSpeakingMotionActive } from '@/domain/voice-tts/lifecycle';
import { speakingTimelineEvent, visemeStopEvent, type TtsSpeakingTimelineEvent, type TtsVisemeEvent } from '@/domain/voice-tts/viseme';
import { ttsPlaybackStartEvent, ttsPlaybackStoppedEvent } from '@/domain/voice-tts/eval-bridge';
import type { TtsAudioChunk, TtsPlaybackController } from '@/domain/voice-tts/types';
import type { VoiceEvalEvent, VoiceEvalPlaybackStopReason } from '@/domain/voice/evaluation-events';
import type { TtsBargeInPort } from '@/domain/voice-turn/barge-in-controller';

export type TtsPlaybackControllerDeps = {
  now?: () => number;
  onSpeakingChanged?: (event: TtsSpeakingTimelineEvent) => void;
  onViseme?: (event: TtsVisemeEvent) => void;
  onEvalEvent?: (event: VoiceEvalEvent) => void;
};

export class TtsPlaybackControllerImpl implements TtsPlaybackController, TtsBargeInPort {
  private state: TtsPlaybackQueueState = emptyTtsPlaybackQueueState();
  /** utterance ごとの直近の speaking 通知値。差分がある時だけ通知する（イベントの空噴射防止）。 */
  private lastNotifiedSpeaking = new Map<string, boolean>();

  constructor(private readonly deps: TtsPlaybackControllerDeps = {}) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * state 更新後、その utterance の speaking motion に**変化があれば**通知する（口パク残存防止の
   * 要）。一度も playing にならなかった utterance（queued → discarded 等）は speaking が常に
   * false のままなので通知しない —— 「止めた」ではなく「そもそも鳴らなかった」を区別する。
   */
  private syncSpeaking(utteranceId: string, t: number): void {
    const playbackState = playbackStateOf(this.state, utteranceId);
    if (!playbackState) return;
    const speaking = isSpeakingMotionActive(playbackState);
    const previous = this.lastNotifiedSpeaking.get(utteranceId) ?? false;
    if (speaking === previous) return;
    this.lastNotifiedSpeaking.set(utteranceId, speaking);
    this.deps.onSpeakingChanged?.(speakingTimelineEvent(utteranceId, playbackState, t));
    if (!speaking) {
      this.deps.onViseme?.(visemeStopEvent(utteranceId, t));
    }
  }

  /** `TtsPlaybackController.enqueue`: チャンク到着で utterance をキューへ積む（未登録時のみ）。 */
  enqueue(chunk: TtsAudioChunk): void {
    this.state = enqueueUtterance(this.state, chunk.utteranceId);
  }

  startPlayback(utteranceId: string): void {
    this.state = queueStartPlayback(this.state, utteranceId);
    const t = this.now();
    this.syncSpeaking(utteranceId, t);
    this.deps.onEvalEvent?.(ttsPlaybackStartEvent(t));
  }

  /** `TtsPlaybackController.stopPlayback`: 現在再生中の音声を即時停止する。 */
  stopPlayback(utteranceId: string, reason: VoiceEvalPlaybackStopReason = 'cancelled'): void {
    this.state = queueStopPlayback(this.state, utteranceId);
    const t = this.now();
    this.syncSpeaking(utteranceId, t);
    this.deps.onEvalEvent?.(ttsPlaybackStoppedEvent(t, reason));
  }

  /** `TtsPlaybackController.discardQueuedAudio`: 未再生のキュー内音声を破棄する（別責務）。 */
  discardQueuedAudio(utteranceId: string): void {
    this.state = queueDiscardQueuedAudio(this.state, utteranceId);
    this.syncSpeaking(utteranceId, this.now());
  }

  /** 再生が最後まで完了した。停止と同様に speaking/viseme を確実にクリアする。 */
  completePlayback(utteranceId: string): void {
    this.state = queueCompletePlayback(this.state, utteranceId);
    const t = this.now();
    this.syncSpeaking(utteranceId, t);
    this.deps.onEvalEvent?.(ttsPlaybackStoppedEvent(t, 'completed'));
  }

  /**
   * `TtsBargeInPort.duck`(issue #371 追加、#372 の申し送り): 再生音量を下げて発話の継続を
   * 見極める。**停止ではない** —— `playbackState` は変えない(`domain/voice-tts/queue.ts` の
   * `duckPlayback` 参照)ため、speaking motion/viseme は継続する(`syncSpeaking` は
   * `playbackState` だけを見るので、ここでは呼ばない = 通知を発火させない)。
   */
  duck(utteranceId: string): void {
    this.state = queueDuckPlayback(this.state, utteranceId);
  }

  /** `TtsBargeInPort.resume`(issue #371 追加): duck を解除して通常音量へ戻す。再生は継続したまま。 */
  resume(utteranceId: string): void {
    this.state = queueResumePlayback(this.state, utteranceId);
  }

  /** 指定 utterance が現在 duck 中か(テスト・kiosk 配線からの状態確認用)。 */
  isDucked(utteranceId: string): boolean {
    return queueIsDucked(this.state, utteranceId);
  }

  isPlaying(utteranceId: string): boolean {
    return activeUtteranceId(this.state) === utteranceId;
  }

  pendingUtteranceIds(): string[] {
    return queuePendingUtteranceIds(this.state);
  }
}
