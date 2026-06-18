import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifySiteToken, extractToken } from './authorizer';

const SECRET = 'test-secret-key';

function makeToken(siteId: string, expSec: number, secret = SECRET): string {
  const sig = createHmac('sha256', secret).update(`${siteId}.${expSec}`).digest('hex');
  return `${siteId}.${expSec}.${sig}`;
}

describe('verifySiteToken', () => {
  const now = 1_000_000;

  it('authorizes a valid, unexpired token', () => {
    const res = verifySiteToken(makeToken('site-001', now + 60), SECRET, now);
    expect(res.authorized).toBe(true);
    expect(res.siteId).toBe('site-001');
  });

  it('rejects a missing token', () => {
    expect(verifySiteToken(undefined, SECRET, now).authorized).toBe(false);
  });

  it('rejects a malformed token', () => {
    expect(verifySiteToken('a.b', SECRET, now).reason).toBe('malformed_token');
  });

  it('rejects an expired token', () => {
    expect(verifySiteToken(makeToken('site-001', now - 1), SECRET, now).reason).toBe('expired');
  });

  it('rejects a token signed with the wrong secret', () => {
    const res = verifySiteToken(makeToken('site-001', now + 60, 'other'), SECRET, now);
    expect(res.authorized).toBe(false);
    expect(res.reason).toBe('bad_signature');
  });

  it('rejects a tampered siteId (signature mismatch)', () => {
    const token = makeToken('site-001', now + 60);
    const tampered = token.replace('site-001', 'site-999');
    expect(verifySiteToken(tampered, SECRET, now).authorized).toBe(false);
  });
});

describe('extractToken', () => {
  it('strips the Bearer prefix', () => {
    expect(extractToken({ authorization: 'Bearer abc.def.ghi' })).toBe('abc.def.ghi');
  });
  it('accepts a raw token and is case-insensitive on header name', () => {
    expect(extractToken({ Authorization: 'raw-token' })).toBe('raw-token');
  });
  it('returns undefined when absent', () => {
    expect(extractToken(undefined)).toBeUndefined();
    expect(extractToken({})).toBeUndefined();
  });
});
