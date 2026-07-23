import { describe, it, expect } from 'vitest';
import {
  emptyTtsPlaybackQueueState,
  enqueueUtterance,
  startPlayback,
  stopPlayback,
  discardQueuedAudio,
  completePlayback,
  activeUtteranceId,
  pendingUtteranceIds,
  playbackStateOf,
  duckPlayback,
  resumePlayback,
  isDucked,
} from './queue';

describe('TTS playback queue (端末側, issue #371)', () => {
  it('starts empty', () => {
    const state = emptyTtsPlaybackQueueState();
    expect(activeUtteranceId(state)).toBeNull();
    expect(pendingUtteranceIds(state)).toEqual([]);
  });

  it('enqueue adds an utterance in the queued state, preserving order', () => {
    let state = emptyTtsPlaybackQueueState();
    state = enqueueUtterance(state, 'u1');
    state = enqueueUtterance(state, 'u2');
    expect(pendingUtteranceIds(state)).toEqual(['u1', 'u2']);
    expect(playbackStateOf(state, 'u1')).toBe('queued');
  });

  it('enqueue is idempotent for the same utteranceId', () => {
    let state = emptyTtsPlaybackQueueState();
    state = enqueueUtterance(state, 'u1');
    state = enqueueUtterance(state, 'u1');
    expect(pendingUtteranceIds(state)).toEqual(['u1']);
  });

  it('startPlayback moves an utterance to playing and it becomes the active one', () => {
    let state = enqueueUtterance(emptyTtsPlaybackQueueState(), 'u1');
    state = startPlayback(state, 'u1');
    expect(activeUtteranceId(state)).toBe('u1');
    expect(pendingUtteranceIds(state)).toEqual([]);
  });

  it('stopPlayback on the active utterance clears it and moves it to stopped (utterance 単位の再生停止)', () => {
    let state = enqueueUtterance(emptyTtsPlaybackQueueState(), 'u1');
    state = startPlayback(state, 'u1');
    state = stopPlayback(state, 'u1');
    expect(activeUtteranceId(state)).toBeNull();
    expect(playbackStateOf(state, 'u1')).toBe('stopped');
  });

  it('discardQueuedAudio removes a not-yet-played utterance from the pending queue (キュー破棄, 別責務)', () => {
    let state = enqueueUtterance(emptyTtsPlaybackQueueState(), 'u1');
    state = enqueueUtterance(state, 'u2');
    state = discardQueuedAudio(state, 'u2');
    expect(pendingUtteranceIds(state)).toEqual(['u1']);
    expect(playbackStateOf(state, 'u2')).toBe('discarded');
  });

  it('discardQueuedAudio does not touch the utterance currently playing — stopPlayback is required for that', () => {
    let state = enqueueUtterance(emptyTtsPlaybackQueueState(), 'u1');
    state = startPlayback(state, 'u1');
    state = discardQueuedAudio(state, 'u1');
    expect(activeUtteranceId(state)).toBe('u1');
    expect(playbackStateOf(state, 'u1')).toBe('playing');
  });

  it('stopping one utterance does not affect other queued utterances (utterance 単位の独立性)', () => {
    let state = enqueueUtterance(emptyTtsPlaybackQueueState(), 'u1');
    state = enqueueUtterance(state, 'u2');
    state = startPlayback(state, 'u1');
    state = stopPlayback(state, 'u1');
    expect(pendingUtteranceIds(state)).toEqual(['u2']);
    expect(playbackStateOf(state, 'u2')).toBe('queued');
  });

  it('completePlayback on the active utterance clears the active slot without marking it stopped', () => {
    let state = enqueueUtterance(emptyTtsPlaybackQueueState(), 'u1');
    state = startPlayback(state, 'u1');
    state = completePlayback(state, 'u1');
    expect(activeUtteranceId(state)).toBeNull();
    expect(playbackStateOf(state, 'u1')).toBe('completed');
  });

  it('an unknown utteranceId is a no-op for every mutator', () => {
    const state = emptyTtsPlaybackQueueState();
    expect(startPlayback(state, 'missing')).toEqual(state);
    expect(stopPlayback(state, 'missing')).toEqual(state);
    expect(discardQueuedAudio(state, 'missing')).toEqual(state);
    expect(playbackStateOf(state, 'missing')).toBeUndefined();
  });
});

describe('duck/resume (issue #371 追加 — #372 の TtsBargeInPort 実装用, playbackState は変えない)', () => {
  it('新規 enqueue の utterance は ducked ではない', () => {
    const state = enqueueUtterance(emptyTtsPlaybackQueueState(), 'u1');
    expect(isDucked(state, 'u1')).toBe(false);
  });

  it('duckPlayback は再生中の utterance を ducked にするが playbackState は playing のまま', () => {
    let state = enqueueUtterance(emptyTtsPlaybackQueueState(), 'u1');
    state = startPlayback(state, 'u1');
    state = duckPlayback(state, 'u1');
    expect(isDucked(state, 'u1')).toBe(true);
    expect(playbackStateOf(state, 'u1')).toBe('playing');
    expect(activeUtteranceId(state)).toBe('u1'); // duck は「今鳴っている音」の扱いを変えない。
  });

  it('resumePlayback は ducked を解除する（playbackState は playing のまま）', () => {
    let state = enqueueUtterance(emptyTtsPlaybackQueueState(), 'u1');
    state = startPlayback(state, 'u1');
    state = duckPlayback(state, 'u1');
    state = resumePlayback(state, 'u1');
    expect(isDucked(state, 'u1')).toBe(false);
    expect(playbackStateOf(state, 'u1')).toBe('playing');
  });

  it('再生中でない utterance（queued）への duck は no-op（まだ鳴っていない音を duck する意味がない）', () => {
    const state = enqueueUtterance(emptyTtsPlaybackQueueState(), 'u1');
    const ducked = duckPlayback(state, 'u1');
    expect(isDucked(ducked, 'u1')).toBe(false);
    expect(playbackStateOf(ducked, 'u1')).toBe('queued');
  });

  it('stopPlayback は ducked フラグもクリアする（停止後に ducked が残らない）', () => {
    let state = enqueueUtterance(emptyTtsPlaybackQueueState(), 'u1');
    state = startPlayback(state, 'u1');
    state = duckPlayback(state, 'u1');
    state = stopPlayback(state, 'u1');
    expect(isDucked(state, 'u1')).toBe(false);
    expect(playbackStateOf(state, 'u1')).toBe('stopped');
  });

  it('discardQueuedAudio は ducked フラグもクリアする', () => {
    let state = enqueueUtterance(emptyTtsPlaybackQueueState(), 'u1');
    state = enqueueUtterance(state, 'u2');
    state = discardQueuedAudio(state, 'u2');
    expect(isDucked(state, 'u2')).toBe(false);
  });

  it('completePlayback は ducked フラグもクリアする', () => {
    let state = enqueueUtterance(emptyTtsPlaybackQueueState(), 'u1');
    state = startPlayback(state, 'u1');
    state = duckPlayback(state, 'u1');
    state = completePlayback(state, 'u1');
    expect(isDucked(state, 'u1')).toBe(false);
  });

  it('duck/resume は他の utterance に影響しない（utterance 単位の独立性）', () => {
    let state = enqueueUtterance(emptyTtsPlaybackQueueState(), 'u1');
    state = enqueueUtterance(state, 'u2');
    state = startPlayback(state, 'u1');
    state = duckPlayback(state, 'u1');
    expect(isDucked(state, 'u2')).toBe(false);
  });

  it('未知の utteranceId への duck/resume は no-op', () => {
    const state = emptyTtsPlaybackQueueState();
    expect(duckPlayback(state, 'missing')).toEqual(state);
    expect(resumePlayback(state, 'missing')).toEqual(state);
    expect(isDucked(state, 'missing')).toBe(false);
  });
});
