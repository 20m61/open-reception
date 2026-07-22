import { describe, it, expect } from 'vitest';
import { checkTokenBinding, isReplayedJti } from './token';
import type { VoiceTransportConnectionContext, VoiceTransportTokenClaims } from './types';

function claims(overrides: Partial<VoiceTransportTokenClaims> = {}): VoiceTransportTokenClaims {
  return {
    tenantId: 'tenant-1',
    siteId: 'site-1',
    kioskId: 'kiosk-1',
    receptionSessionId: 'reception-1',
    jti: 'jti-1',
    ...overrides,
  };
}

function context(overrides: Partial<VoiceTransportConnectionContext> = {}): VoiceTransportConnectionContext {
  return {
    tenantId: 'tenant-1',
    siteId: 'site-1',
    kioskId: 'kiosk-1',
    receptionSessionId: 'reception-1',
    ...overrides,
  };
}

describe('checkTokenBinding', () => {
  it('accepts when claims exactly match the connection context', () => {
    expect(checkTokenBinding(claims(), context())).toBeNull();
  });

  it('rejects a token issued for another tenant', () => {
    expect(checkTokenBinding(claims({ tenantId: 'tenant-2' }), context())).toBe('tenant_mismatch');
  });

  it('rejects a token issued for another site (even within the same tenant)', () => {
    expect(checkTokenBinding(claims({ siteId: 'site-2' }), context())).toBe('site_mismatch');
  });

  it('rejects a token issued for another kiosk device', () => {
    expect(checkTokenBinding(claims({ kioskId: 'kiosk-2' }), context())).toBe('kiosk_mismatch');
  });

  it('rejects a token issued for another reception session', () => {
    expect(checkTokenBinding(claims({ receptionSessionId: 'reception-2' }), context())).toBe('reception_mismatch');
  });

  it('checks tenant before site/kiosk/reception so the earliest boundary violation wins', () => {
    expect(
      checkTokenBinding(claims({ tenantId: 'tenant-2', siteId: 'site-9', kioskId: 'kiosk-9' }), context()),
    ).toBe('tenant_mismatch');
  });
});

describe('isReplayedJti', () => {
  it('is not a replay the first time a jti is seen', () => {
    expect(isReplayedJti('jti-1', new Set())).toBe(false);
  });

  it('is a replay once the jti has been recorded as consumed', () => {
    expect(isReplayedJti('jti-1', new Set(['jti-1']))).toBe(true);
  });

  it('does not confuse distinct jti values', () => {
    expect(isReplayedJti('jti-2', new Set(['jti-1']))).toBe(false);
  });
});
