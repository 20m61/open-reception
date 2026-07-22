import { describe, it, expect } from 'vitest';
import {
  fallbackEventForLifecycle,
  fallbackEventForRuntimeStatus,
  type VoiceTransportRuntimeStatus,
} from './fallback';

describe('fallbackEventForLifecycle', () => {
  it('returns null while healthy or transiently reconnecting', () => {
    expect(fallbackEventForLifecycle('idle', 0)).toBeNull();
    expect(fallbackEventForLifecycle('connecting', 0)).toBeNull();
    expect(fallbackEventForLifecycle('connected', 0)).toBeNull();
    expect(fallbackEventForLifecycle('reconnecting', 0)).toBeNull();
  });

  it('emits a fallback-required event once the lifecycle gives up (degraded)', () => {
    const event = fallbackEventForLifecycle('degraded', 1234);
    expect(event).toEqual({ type: 'voiceTransportFallbackRequired', reason: 'reconnect_exhausted', t: 1234 });
  });

  it('does not emit for a deliberate close by itself', () => {
    expect(fallbackEventForLifecycle('closed', 0)).toBeNull();
  });
});

describe('fallbackEventForRuntimeStatus', () => {
  it.each<[VoiceTransportRuntimeStatus, boolean]>([
    ['ready', false],
    ['preparing', true],
    ['stopped', true],
    ['degraded', true],
  ])('status=%s -> fallback required=%s', (status, required) => {
    const event = fallbackEventForRuntimeStatus(status, 500);
    if (required) {
      expect(event).toEqual({ type: 'voiceTransportFallbackRequired', reason: `runtime_${status}`, t: 500 });
    } else {
      expect(event).toBeNull();
    }
  });
});
