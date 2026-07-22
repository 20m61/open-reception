import { describe, it, expect } from 'vitest';
import {
  DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG,
  isValidVoiceTransportAudioConfig,
} from './types';

describe('isValidVoiceTransportAudioConfig', () => {
  it('accepts the ADR default (16kHz/16bit mono, 20ms chunk)', () => {
    expect(isValidVoiceTransportAudioConfig(DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG)).toBe(true);
  });

  it('accepts chunk sizes within the 20-40ms band', () => {
    expect(isValidVoiceTransportAudioConfig({ ...DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG, chunkMs: 40 })).toBe(true);
    expect(isValidVoiceTransportAudioConfig({ ...DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG, chunkMs: 30 })).toBe(true);
  });

  it('rejects chunk sizes outside the 20-40ms band', () => {
    expect(isValidVoiceTransportAudioConfig({ ...DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG, chunkMs: 19 })).toBe(false);
    expect(isValidVoiceTransportAudioConfig({ ...DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG, chunkMs: 41 })).toBe(false);
  });

  it('rejects non-finite or non-positive sample rates', () => {
    expect(isValidVoiceTransportAudioConfig({ ...DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG, sampleRateHz: 0 })).toBe(false);
    expect(
      isValidVoiceTransportAudioConfig({ ...DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG, sampleRateHz: Number.NaN }),
    ).toBe(false);
  });
});
