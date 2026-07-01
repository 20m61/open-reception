/**
 * 受付端末 PIN 許可ルートの単体テスト。#244: pinRequired=false では authorize が公開セッションを
 * 発行しない（403）ことと、pinRequired=true 時の PIN 検証を担保する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSecuritySettings = vi.fn();
const verifyPin = vi.fn();
const issueKioskSession = vi.fn();

vi.mock('@/lib/security/security-store', () => ({
  getSecuritySettings: (...a: unknown[]) => getSecuritySettings(...a),
  verifyPin: (...a: unknown[]) => verifyPin(...a),
}));
vi.mock('@/lib/auth/kiosk', () => ({
  KIOSK_COOKIE: 'kiosk_session',
  KIOSK_SESSION_TTL_MS: 1000,
  issueKioskSession: (...a: unknown[]) => issueKioskSession(...a),
}));

import { POST } from './route';

function post(body: unknown = { pin: '0000', kioskId: 'kiosk-dev' }) {
  return POST(
    new Request('http://localhost/api/kiosk/authorize', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getSecuritySettings.mockResolvedValue({ pinRequired: true, pin: '0000', ipAllowlist: [] });
  verifyPin.mockResolvedValue(true);
  issueKioskSession.mockResolvedValue('signed-kiosk-session');
});

describe('POST /api/kiosk/authorize (#244)', () => {
  it('pinRequired=false では 403（公開セッションを発行しない・ゲート回避防止）', async () => {
    getSecuritySettings.mockResolvedValue({ pinRequired: false, pin: '0000', ipAllowlist: [] });
    const res = await post();
    expect(res.status).toBe(403);
    expect(issueKioskSession).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('pinRequired=true かつ PIN 一致でセッションを発行し Set-Cookie', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(issueKioskSession).toHaveBeenCalledTimes(1);
    expect(res.headers.get('set-cookie')).toContain('kiosk_session=');
  });

  it('pinRequired=true でも PIN 不一致は 401', async () => {
    verifyPin.mockResolvedValue(false);
    const res = await post({ pin: 'wrong' });
    expect(res.status).toBe(401);
    expect(issueKioskSession).not.toHaveBeenCalled();
  });

  it('IP allowlist 設定済みでも pinRequired=false は 403（IP 単独では認可しない・詐称対策, #244）', async () => {
    // x-forwarded-for は client 詐称可能なため、IP allowlist 単独ではセッションを発行しない。
    getSecuritySettings.mockResolvedValue({ pinRequired: false, pin: '0000', ipAllowlist: ['1.2.3.4'] });
    const res = await POST(
      new Request('http://localhost/api/kiosk/authorize', {
        method: 'POST',
        headers: { 'x-forwarded-for': '1.2.3.4' },
        body: JSON.stringify({ kioskId: 'kiosk-dev' }),
      }),
    );
    expect(res.status).toBe(403);
    expect(issueKioskSession).not.toHaveBeenCalled();
  });
});
