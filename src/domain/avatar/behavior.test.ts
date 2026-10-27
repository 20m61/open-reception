import { describe, expect, it } from 'vitest';
import { VOICE_KIOSK_MODES, type VoiceKioskMode } from '@/domain/voice-session/kiosk-view';
import {
  deriveAvatarBehavior,
  type AvatarBehaviorPhase,
} from './behavior';

const EXPECTED_PHASE: Record<VoiceKioskMode, AvatarBehaviorPhase> = {
  inactive: 'ambient',
  idle: 'ambient',
  listening: 'listening',
  readback: 'ambient',
  speaking: 'speaking',
  ducked: 'listening',
  fallback: 'ambient',
  unavailable: 'ambient',
};

describe('deriveAvatarBehavior', () => {
  it('VoiceKioskMode を独自遷移なしで描画 phase へ導出する', () => {
    for (const voiceMode of VOICE_KIOSK_MODES) {
      const behavior = deriveAvatarBehavior({ avatarState: 'guiding', voiceMode });
      expect(behavior.phase).toBe(EXPECTED_PHASE[voiceMode]);
      expect(behavior.baseState).toBe('guiding');
      expect(behavior.speaking).toBe(voiceMode === 'speaking');
      expect(behavior.listenFocus).toBe(voiceMode === 'listening' || voiceMode === 'ducked');
    }
  });

  it('barge-in duck は即座に listening behavior として扱う', () => {
    expect(
      deriveAvatarBehavior({ avatarState: 'confirming', voiceMode: 'ducked' }),
    ).toEqual({
      baseState: 'confirming',
      phase: 'listening',
      speaking: false,
      listenFocus: true,
    });
  });

  it('responsePending は voice idle のときだけ thinking へ昇格する', () => {
    expect(
      deriveAvatarBehavior({ avatarState: 'guiding', voiceMode: 'idle', responsePending: true }),
    ).toMatchObject({ phase: 'thinking', speaking: false, listenFocus: false });

    for (const voiceMode of ['inactive', 'readback', 'fallback', 'unavailable'] as const) {
      expect(
        deriveAvatarBehavior({ avatarState: 'guiding', voiceMode, responsePending: true }).phase,
      ).toBe('ambient');
    }
  });

  it('speaking/listening の事実は responsePending より優先する', () => {
    expect(
      deriveAvatarBehavior({ avatarState: 'guiding', voiceMode: 'speaking', responsePending: true }).phase,
    ).toBe('speaking');
    expect(
      deriveAvatarBehavior({ avatarState: 'guiding', voiceMode: 'listening', responsePending: true }).phase,
    ).toBe('listening');
    expect(
      deriveAvatarBehavior({ avatarState: 'guiding', voiceMode: 'ducked', responsePending: true }).phase,
    ).toBe('listening');
  });

  it('受付上の AvatarState は conversation phase によって書き換えない', () => {
    for (const avatarState of ['idle', 'greeting', 'calling', 'apologizing', 'farewell'] as const) {
      expect(deriveAvatarBehavior({ avatarState, voiceMode: 'speaking' }).baseState).toBe(avatarState);
    }
  });
});
