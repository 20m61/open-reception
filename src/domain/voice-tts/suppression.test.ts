import { describe, it, expect } from 'vitest';
import { shouldSuppressCharacterTts } from './suppression';

describe('shouldSuppressCharacterTts (issue #371 AC: connected/live_bridge 中は TTS を抑止する)', () => {
  it('does not suppress when idle (no call, no live_bridge)', () => {
    expect(shouldSuppressCharacterTts({ callConnected: false, liveBridgeActive: false })).toBe(false);
  });

  it('suppresses while a call is connected', () => {
    expect(shouldSuppressCharacterTts({ callConnected: true, liveBridgeActive: false })).toBe(true);
  });

  it('suppresses while a live_bridge routing step is active, even before the call reports connected', () => {
    expect(shouldSuppressCharacterTts({ callConnected: false, liveBridgeActive: true })).toBe(true);
  });

  it('suppresses when both are true', () => {
    expect(shouldSuppressCharacterTts({ callConnected: true, liveBridgeActive: true })).toBe(true);
  });

  it('is a pure function of its input — same input always yields the same output', () => {
    const input = { callConnected: true, liveBridgeActive: false };
    expect(shouldSuppressCharacterTts(input)).toBe(shouldSuppressCharacterTts({ ...input }));
  });
});
