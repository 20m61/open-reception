import { describe, it, expect } from 'vitest';
import {
  visemeTimelineFromSpeechMarks,
  visemeTimelineFromAmplitude,
  visemeStopEvent,
  speakingTimelineEvent,
  TTS_VISEME_IDS,
} from './viseme';
import { isSpeakingMotionActive } from './lifecycle';

describe('visemeTimelineFromSpeechMarks (Polly Speech Marks → 中立 viseme イベント, issue #371)', () => {
  it('maps viseme-type speech marks to viseme events ordered by time', () => {
    const events = visemeTimelineFromSpeechMarks('u1', [
      { timeMs: 0, type: 'viseme', value: 'sil' },
      { timeMs: 50, type: 'viseme', value: 'a' },
      { timeMs: 100, type: 'word', value: 'こんにちは' }, // viseme 以外は無視
      { timeMs: 150, type: 'viseme', value: 'i' },
    ]);
    expect(events.map((e) => e.viseme)).toEqual(['sil', 'a', 'i']);
    expect(events.map((e) => e.audioTimestampMs)).toEqual([0, 50, 150]);
    expect(events.every((e) => e.utteranceId === 'u1')).toBe(true);
  });

  it('gives sil a 0 mouthOpenHint and vowel visemes a positive hint', () => {
    const events = visemeTimelineFromSpeechMarks('u1', [
      { timeMs: 0, type: 'viseme', value: 'sil' },
      { timeMs: 10, type: 'viseme', value: 'a' },
    ]);
    expect(events[0]!.mouthOpenHint).toBe(0);
    expect(events[1]!.mouthOpenHint).toBeGreaterThan(0);
  });

  it('falls back to sil for an unrecognized viseme value rather than throwing', () => {
    const events = visemeTimelineFromSpeechMarks('u1', [{ timeMs: 0, type: 'viseme', value: 'not-a-real-viseme' }]);
    expect(events[0]!.viseme).toBe('sil');
    expect(events[0]!.mouthOpenHint).toBe(0);
  });

  it('every emitted viseme id is one of the documented TTS_VISEME_IDS', () => {
    const events = visemeTimelineFromSpeechMarks('u1', [
      { timeMs: 0, type: 'viseme', value: 'p' },
      { timeMs: 10, type: 'viseme', value: 'k' },
    ]);
    for (const e of events) expect(TTS_VISEME_IDS).toContain(e.viseme);
  });
});

describe('visemeTimelineFromAmplitude (音量解析 → 中立 viseme イベント, issue #371)', () => {
  it('maps samples above the threshold to an open-mouth viseme and below to sil', () => {
    const events = visemeTimelineFromAmplitude('u1', [
      { tMs: 0, amplitude: 0.0 },
      { tMs: 20, amplitude: 0.8 },
      { tMs: 40, amplitude: 0.05 },
    ]);
    expect(events[0]!.viseme).toBe('sil');
    expect(events[1]!.viseme).not.toBe('sil');
    expect(events[2]!.viseme).toBe('sil');
  });

  it('mouthOpenHint tracks amplitude directly (clamped to [0,1])', () => {
    const events = visemeTimelineFromAmplitude('u1', [
      { tMs: 0, amplitude: 0.5 },
      { tMs: 10, amplitude: 1.5 }, // 過大入力もクランプする
      { tMs: 20, amplitude: -0.5 }, // 負値もクランプする
    ]);
    expect(events[0]!.mouthOpenHint).toBe(0.5);
    expect(events[1]!.mouthOpenHint).toBe(1);
    expect(events[2]!.mouthOpenHint).toBe(0);
  });
});

describe('visemeStopEvent (issue #371 AC: 停止時に口パクが残らない)', () => {
  it('always returns a sil viseme with mouthOpenHint 0 at the given time', () => {
    const event = visemeStopEvent('u1', 1234);
    expect(event).toEqual({ utteranceId: 'u1', audioTimestampMs: 1234, viseme: 'sil', mouthOpenHint: 0 });
  });
});

describe('speakingTimelineEvent (中立 speaking タイムライン, issue #371)', () => {
  it('derives speaking=true while playbackState is playing, matching isSpeakingMotionActive', () => {
    const event = speakingTimelineEvent('u1', 'playing', 500);
    expect(event).toEqual({ utteranceId: 'u1', speaking: true, t: 500 });
    expect(event.speaking).toBe(isSpeakingMotionActive('playing'));
  });

  it('derives speaking=false for every terminal playback state (no residual mouth motion)', () => {
    for (const state of ['stopped', 'discarded', 'completed'] as const) {
      const event = speakingTimelineEvent('u1', state, 999);
      expect(event.speaking).toBe(false);
      expect(event.speaking).toBe(isSpeakingMotionActive(state));
    }
  });
});
