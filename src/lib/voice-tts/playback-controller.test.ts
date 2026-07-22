import { describe, it, expect } from 'vitest';
import { TtsPlaybackControllerImpl } from './playback-controller';
import type { VoiceEvalEvent } from '@/domain/voice/evaluation-events';
import type { TtsSpeakingTimelineEvent, TtsVisemeEvent } from '@/domain/voice-tts/viseme';

function makeChunk(utteranceId: string, seq: number, final: boolean) {
  return { utteranceId, seq, audioTimestampMs: seq * 20, byteLength: 100, final };
}

describe('TtsPlaybackControllerImpl (issue #371 AC: utterance 単位の再生停止・キュー破棄)', () => {
  it('enqueue then startPlayback marks the utterance active and emits a speaking=true timeline event', () => {
    const speaking: TtsSpeakingTimelineEvent[] = [];
    const controller = new TtsPlaybackControllerImpl({ now: () => 0, onSpeakingChanged: (e) => speaking.push(e) });
    controller.enqueue(makeChunk('u1', 0, true));
    controller.startPlayback('u1');
    expect(controller.isPlaying('u1')).toBe(true);
    expect(speaking).toEqual([{ utteranceId: 'u1', speaking: true, t: 0 }]);
  });

  it('AC: stopPlayback halts the specific utterance and emits speaking=false immediately (no residual mouth motion)', () => {
    const speaking: TtsSpeakingTimelineEvent[] = [];
    const visemes: TtsVisemeEvent[] = [];
    let t = 0;
    const controller = new TtsPlaybackControllerImpl({
      now: () => t,
      onSpeakingChanged: (e) => speaking.push(e),
      onViseme: (e) => visemes.push(e),
    });
    controller.enqueue(makeChunk('u1', 0, true));
    controller.startPlayback('u1');
    t = 500;
    controller.stopPlayback('u1');

    expect(controller.isPlaying('u1')).toBe(false);
    const last = speaking.at(-1)!;
    expect(last).toEqual({ utteranceId: 'u1', speaking: false, t: 500 });
    // 口を閉じる viseme (sil, mouthOpenHint 0) が停止と同時に出ること。
    const lastViseme = visemes.at(-1)!;
    expect(lastViseme).toEqual({ utteranceId: 'u1', audioTimestampMs: 500, viseme: 'sil', mouthOpenHint: 0 });
  });

  it('AC: stopPlayback only affects the targeted utterance, leaving other queued utterances untouched', () => {
    const controller = new TtsPlaybackControllerImpl({ now: () => 0 });
    controller.enqueue(makeChunk('u1', 0, true));
    controller.enqueue(makeChunk('u2', 0, true));
    controller.startPlayback('u1');
    controller.stopPlayback('u1');
    expect(controller.pendingUtteranceIds()).toEqual(['u2']);
  });

  it('AC: discardQueuedAudio removes a not-yet-played utterance without ever marking it as having spoken', () => {
    const speaking: TtsSpeakingTimelineEvent[] = [];
    const controller = new TtsPlaybackControllerImpl({ now: () => 0, onSpeakingChanged: (e) => speaking.push(e) });
    controller.enqueue(makeChunk('u1', 0, true));
    controller.enqueue(makeChunk('u2', 0, true));
    controller.discardQueuedAudio('u2');
    expect(controller.pendingUtteranceIds()).toEqual(['u1']);
    // discard された utterance は一度も speaking=true にならない。
    expect(speaking.some((e) => e.utteranceId === 'u2')).toBe(false);
  });

  it('discarding the currently-playing utterance is a no-op — stopPlayback is required for that (separate responsibility)', () => {
    const controller = new TtsPlaybackControllerImpl({ now: () => 0 });
    controller.enqueue(makeChunk('u1', 0, true));
    controller.startPlayback('u1');
    controller.discardQueuedAudio('u1');
    expect(controller.isPlaying('u1')).toBe(true);
  });

  it('emits #365-shaped tts.playback_start / tts.playback_stopped events with the given reason', () => {
    const events: VoiceEvalEvent[] = [];
    const controller = new TtsPlaybackControllerImpl({ now: () => 42, onEvalEvent: (e) => events.push(e) });
    controller.enqueue(makeChunk('u1', 0, true));
    controller.startPlayback('u1');
    controller.stopPlayback('u1', 'barge_in');
    expect(events).toEqual([
      { type: 'tts.playback_start', t: 42, turnIndex: 0 },
      { type: 'tts.playback_stopped', t: 42, turnIndex: 0, reason: 'barge_in' },
    ]);
  });

  it('completePlayback marks the utterance completed, clears active, and emits speaking=false + sil viseme too', () => {
    const speaking: TtsSpeakingTimelineEvent[] = [];
    const controller = new TtsPlaybackControllerImpl({ now: () => 10, onSpeakingChanged: (e) => speaking.push(e) });
    controller.enqueue(makeChunk('u1', 0, true));
    controller.startPlayback('u1');
    controller.completePlayback('u1');
    expect(controller.isPlaying('u1')).toBe(false);
    expect(speaking.at(-1)).toEqual({ utteranceId: 'u1', speaking: false, t: 10 });
  });
});
