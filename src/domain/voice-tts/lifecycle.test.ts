import { describe, it, expect } from 'vitest';
import {
  transitionGeneration,
  transitionPlayback,
  isSpeakingMotionActive,
  TTS_GENERATION_STATES,
  TTS_PLAYBACK_STATES,
} from './lifecycle';

describe('TTS generation lifecycle (provider 側, issue #371)', () => {
  it('idle -REQUEST-> requested -FIRST_CHUNK-> streaming -COMPLETE-> completed', () => {
    let state = transitionGeneration('idle', { type: 'REQUEST' });
    expect(state).toBe('requested');
    state = transitionGeneration(state, { type: 'FIRST_CHUNK' });
    expect(state).toBe('streaming');
    state = transitionGeneration(state, { type: 'CHUNK' });
    expect(state).toBe('streaming');
    state = transitionGeneration(state, { type: 'COMPLETE' });
    expect(state).toBe('completed');
  });

  it('ABORT from streaming moves to aborted (provider 側の生成中止)', () => {
    let state = transitionGeneration('idle', { type: 'REQUEST' });
    state = transitionGeneration(state, { type: 'FIRST_CHUNK' });
    state = transitionGeneration(state, { type: 'ABORT' });
    expect(state).toBe('aborted');
  });

  it('ERROR from any non-terminal state moves to error', () => {
    expect(transitionGeneration('requested', { type: 'ERROR' })).toBe('error');
    expect(transitionGeneration('streaming', { type: 'ERROR' })).toBe('error');
  });

  it('terminal states (completed/aborted/error) are absorbing — 二重遷移を無視する', () => {
    expect(transitionGeneration('completed', { type: 'CHUNK' })).toBe('completed');
    expect(transitionGeneration('aborted', { type: 'CHUNK' })).toBe('aborted');
    expect(transitionGeneration('error', { type: 'COMPLETE' })).toBe('error');
  });

  it('exposes the full state list for exhaustiveness checks', () => {
    expect(TTS_GENERATION_STATES).toEqual(['idle', 'requested', 'streaming', 'completed', 'aborted', 'error']);
  });
});

describe('TTS playback lifecycle (端末側, issue #371)', () => {
  it('idle -ENQUEUE-> queued -START-> playing -COMPLETE-> completed', () => {
    let state = transitionPlayback('idle', { type: 'ENQUEUE' });
    expect(state).toBe('queued');
    state = transitionPlayback(state, { type: 'START' });
    expect(state).toBe('playing');
    state = transitionPlayback(state, { type: 'COMPLETE' });
    expect(state).toBe('completed');
  });

  it('STOP from playing moves to stopped (utterance 単位の再生停止, issue #371 AC)', () => {
    let state = transitionPlayback('idle', { type: 'ENQUEUE' });
    state = transitionPlayback(state, { type: 'START' });
    state = transitionPlayback(state, { type: 'STOP' });
    expect(state).toBe('stopped');
  });

  it('DISCARD from queued moves to discarded without ever entering playing (キュー破棄, issue #371 AC)', () => {
    const state = transitionPlayback(transitionPlayback('idle', { type: 'ENQUEUE' }), { type: 'DISCARD' });
    expect(state).toBe('discarded');
  });

  it('DISCARD on an already-playing utterance is a no-op — stopPlayback is the separate responsibility for that', () => {
    let state = transitionPlayback('idle', { type: 'ENQUEUE' });
    state = transitionPlayback(state, { type: 'START' });
    const next = transitionPlayback(state, { type: 'DISCARD' });
    expect(next).toBe('playing');
  });

  it('terminal states (stopped/discarded/completed) are absorbing — a stale START never resumes speech', () => {
    expect(transitionPlayback('stopped', { type: 'START' })).toBe('stopped');
    expect(transitionPlayback('discarded', { type: 'START' })).toBe('discarded');
    expect(transitionPlayback('completed', { type: 'START' })).toBe('completed');
  });

  it('exposes the full state list for exhaustiveness checks', () => {
    expect(TTS_PLAYBACK_STATES).toEqual(['idle', 'queued', 'playing', 'stopped', 'discarded', 'completed']);
  });
});

describe('isSpeakingMotionActive (issue #371 AC: 停止時に口パク/speaking motion が残らない)', () => {
  it('is true only while playbackState === playing', () => {
    expect(isSpeakingMotionActive('idle')).toBe(false);
    expect(isSpeakingMotionActive('queued')).toBe(false);
    expect(isSpeakingMotionActive('playing')).toBe(true);
  });

  it('is false immediately for every terminal state reachable after STOP/DISCARD/COMPLETE', () => {
    expect(isSpeakingMotionActive('stopped')).toBe(false);
    expect(isSpeakingMotionActive('discarded')).toBe(false);
    expect(isSpeakingMotionActive('completed')).toBe(false);
  });

  it('a full stop transition sequence never leaves motion active — this is the invariant the controller relies on', () => {
    let state = transitionPlayback('idle', { type: 'ENQUEUE' });
    state = transitionPlayback(state, { type: 'START' });
    expect(isSpeakingMotionActive(state)).toBe(true);
    state = transitionPlayback(state, { type: 'STOP' });
    expect(isSpeakingMotionActive(state)).toBe(false);
  });
});
