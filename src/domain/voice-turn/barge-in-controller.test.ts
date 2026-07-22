import { describe, expect, it, vi } from 'vitest';

import {
  applyBargeInAction,
  initialBargeInControllerState,
  onNearEndOnset,
  onNearEndUpdate,
  type TtsBargeInPort,
} from './barge-in-controller';

function mockPort(): TtsBargeInPort {
  return { duck: vi.fn(), resume: vi.fn(), stopPlayback: vi.fn(), discardQueuedAudio: vi.fn() };
}

describe('onNearEndOnset', () => {
  it('idle から ducked へ遷移し duck アクションを返す', () => {
    const { state, action } = onNearEndOnset(initialBargeInControllerState(), 'utt-1');
    expect(state).toEqual({ phase: 'ducked', utteranceId: 'utt-1' });
    expect(action).toEqual({ type: 'duck', utteranceId: 'utt-1' });
  });

  it('既に ducked/stopped 中は no-op（多重 onset を無視する）', () => {
    const ducked = onNearEndOnset(initialBargeInControllerState(), 'utt-1').state;
    const { state, action } = onNearEndOnset(ducked, 'utt-2');
    expect(state).toBe(ducked);
    expect(action).toEqual({ type: 'noop' });
  });
});

describe('onNearEndUpdate', () => {
  it('pending の間は ducked のまま await を返す', () => {
    const ducked = onNearEndOnset(initialBargeInControllerState(), 'utt-1').state;
    const { state, action, classification } = onNearEndUpdate(ducked, { text: '', sustainedMs: 50 });
    expect(classification).toBe('pending');
    expect(action).toEqual({ type: 'await' });
    expect(state).toBe(ducked);
  });

  it('backchannel と判定したら idle へ戻り resume を返す（再生は続く）', () => {
    const ducked = onNearEndOnset(initialBargeInControllerState(), 'utt-1').state;
    const { state, action, classification } = onNearEndUpdate(ducked, { text: 'はい', sustainedMs: 200 });
    expect(classification).toBe('backchannel');
    expect(action).toEqual({ type: 'resume', utteranceId: 'utt-1', classification: 'backchannel' });
    expect(state).toEqual({ phase: 'idle', utteranceId: null });
  });

  it('true interruption と判定したら stopped へ遷移し stop_and_discard + VRM listening を返す', () => {
    const ducked = onNearEndOnset(initialBargeInControllerState(), 'utt-1').state;
    const { state, action, classification } = onNearEndUpdate(ducked, { text: 'ちょっと待って', sustainedMs: 10 });
    expect(classification).toBe('interruption');
    expect(action).toEqual({ type: 'stop_and_discard', utteranceId: 'utt-1', vrmState: 'listening' });
    expect(state).toEqual({ phase: 'stopped', utteranceId: 'utt-1' });
  });

  it('echo と判定したら resume（誤って止めない）', () => {
    const ducked = onNearEndOnset(initialBargeInControllerState(), 'utt-1').state;
    const { action, classification } = onNearEndUpdate(ducked, { text: '違います', sustainedMs: 500, echoLikelihood: 0.9 });
    expect(classification).toBe('echo');
    expect(action.type).toBe('resume');
  });

  it('idle 状態での更新は no-op', () => {
    const { state, action, classification } = onNearEndUpdate(initialBargeInControllerState(), { text: 'はい', sustainedMs: 200 });
    expect(action).toEqual({ type: 'noop' });
    expect(classification).toBe('pending');
    expect(state).toEqual(initialBargeInControllerState());
  });
});

describe('applyBargeInAction', () => {
  it('duck アクションは port.duck を呼ぶ', () => {
    const port = mockPort();
    applyBargeInAction({ type: 'duck', utteranceId: 'utt-1' }, port);
    expect(port.duck).toHaveBeenCalledWith('utt-1');
    expect(port.stopPlayback).not.toHaveBeenCalled();
  });

  it('stop_and_discard アクションは stopPlayback と discardQueuedAudio の両方を呼ぶ', () => {
    const port = mockPort();
    applyBargeInAction({ type: 'stop_and_discard', utteranceId: 'utt-1', vrmState: 'listening' }, port);
    expect(port.stopPlayback).toHaveBeenCalledWith('utt-1');
    expect(port.discardQueuedAudio).toHaveBeenCalledWith('utt-1');
  });

  it('resume アクションは port.resume を呼ぶ', () => {
    const port = mockPort();
    applyBargeInAction({ type: 'resume', utteranceId: 'utt-1', classification: 'backchannel' }, port);
    expect(port.resume).toHaveBeenCalledWith('utt-1');
  });

  it('await/noop は何も呼ばない', () => {
    const port = mockPort();
    applyBargeInAction({ type: 'await' }, port);
    applyBargeInAction({ type: 'noop' }, port);
    expect(port.duck).not.toHaveBeenCalled();
    expect(port.resume).not.toHaveBeenCalled();
    expect(port.stopPlayback).not.toHaveBeenCalled();
    expect(port.discardQueuedAudio).not.toHaveBeenCalled();
  });
});

describe('一連の流れ（相づち → 真の割り込み、issue #372 の連続近端発話ケース）', () => {
  it('相づちで resume した後、同じ再生中に新しい near-end onset が来たら再度 duck できる', () => {
    let s = onNearEndOnset(initialBargeInControllerState(), 'utt-1').state;
    s = onNearEndUpdate(s, { text: 'はい', sustainedMs: 200 }).state;
    expect(s.phase).toBe('idle');

    const second = onNearEndOnset(s, 'utt-1');
    expect(second.action).toEqual({ type: 'duck', utteranceId: 'utt-1' });

    const result = onNearEndUpdate(second.state, { text: '違います', sustainedMs: 10 });
    expect(result.classification).toBe('interruption');
    expect(result.action.type).toBe('stop_and_discard');
  });
});
