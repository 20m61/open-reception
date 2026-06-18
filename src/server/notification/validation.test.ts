import { describe, it, expect } from 'vitest';
import { validateNotificationRequest, MAX_MESSAGE_LENGTH } from './validation';

describe('validateNotificationRequest', () => {
  const valid = {
    siteId: 'site-001',
    requestId: 'req-abc',
    kind: 'call',
    message: '田中様がお見えです',
  };

  it('accepts a minimal valid request and trims fields', () => {
    const res = validateNotificationRequest({ ...valid, siteId: '  site-001  ' });
    expect(res.ok).toBe(true);
    expect(res.value?.siteId).toBe('site-001');
    expect(res.value?.target).toBeUndefined();
  });

  it('accepts a valid optional target', () => {
    const res = validateNotificationRequest({
      ...valid,
      target: { type: 'phone', value: '+819012345678' },
    });
    expect(res.ok).toBe(true);
    expect(res.value?.target).toEqual({ type: 'phone', value: '+819012345678' });
  });

  it('rejects non-object body', () => {
    expect(validateNotificationRequest('nope').ok).toBe(false);
    expect(validateNotificationRequest(null).ok).toBe(false);
  });

  it('requires siteId, requestId, kind, message', () => {
    const res = validateNotificationRequest({});
    expect(res.ok).toBe(false);
    expect(res.errors.length).toBeGreaterThanOrEqual(4);
  });

  it('rejects unknown kind', () => {
    const res = validateNotificationRequest({ ...valid, kind: 'sms' });
    expect(res.ok).toBe(false);
  });

  it('rejects over-long message', () => {
    const res = validateNotificationRequest({ ...valid, message: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) });
    expect(res.ok).toBe(false);
  });

  it('rejects malformed target', () => {
    expect(validateNotificationRequest({ ...valid, target: { type: 'fax', value: 'x' } }).ok).toBe(false);
    expect(validateNotificationRequest({ ...valid, target: { type: 'phone' } }).ok).toBe(false);
  });

  it('rejects siteId/requestId with path-injection characters (allowlist)', () => {
    expect(validateNotificationRequest({ ...valid, siteId: 'a/../../other' }).ok).toBe(false);
    expect(validateNotificationRequest({ ...valid, siteId: 'site/001' }).ok).toBe(false);
    expect(validateNotificationRequest({ ...valid, requestId: 'req id' }).ok).toBe(false);
    expect(validateNotificationRequest({ ...valid, siteId: 'site_001-A' }).ok).toBe(true);
  });

  it('applies the message length cap to the trimmed value', () => {
    // 600 本文 + 末尾空白 → trim 後 600 で通過。
    const padded = `${'x'.repeat(MAX_MESSAGE_LENGTH)}     `;
    expect(validateNotificationRequest({ ...valid, message: padded }).ok).toBe(true);
    // trim 後 601 は拒否。
    expect(validateNotificationRequest({ ...valid, message: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) }).ok).toBe(false);
  });
});
