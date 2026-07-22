import { describe, it, expect } from 'vitest';
import {
  VOICE_STT_FALLBACK_REASONS,
  fallbackEventForSttError,
  fallbackEventForSttStatus,
} from './fallback';

describe('fallbackEventForSttError', () => {
  it('produces a neutral fallback event carrying the error code as reason when recognized', () => {
    const event = fallbackEventForSttError('stream_error', 1234);
    expect(event).toEqual({ type: 'voiceSttFallbackRequired', reason: 'stream_error', t: 1234 });
  });

  it('falls back to provider_unavailable for an unrecognized code (defensive default)', () => {
    const event = fallbackEventForSttError('something_unexpected', 10);
    expect(event.reason).toBe('provider_unavailable');
  });

  it('only ever returns reasons from the documented enum', () => {
    const event = fallbackEventForSttError('reconnect_exhausted', 0);
    expect(VOICE_STT_FALLBACK_REASONS).toContain(event.reason);
  });
});

describe('fallbackEventForSttStatus', () => {
  it('returns null when the STT session is healthy', () => {
    expect(fallbackEventForSttStatus('active', 0)).toBeNull();
  });

  it('returns a fallback event when the session has stalled (no partial/final for too long)', () => {
    const event = fallbackEventForSttStatus('stalled', 500);
    expect(event).toEqual({ type: 'voiceSttFallbackRequired', reason: 'no_partial_timeout', t: 500 });
  });

  it('returns a fallback event when the session has closed unexpectedly', () => {
    const event = fallbackEventForSttStatus('closed_unexpectedly', 999);
    expect(event).toEqual({ type: 'voiceSttFallbackRequired', reason: 'provider_unavailable', t: 999 });
  });
});
