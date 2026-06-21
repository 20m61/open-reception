/**
 * kiosk heartbeat ルートの単体テスト。
 *
 * Kiosk→Device 統合 (issue #87 inc3): heartbeat が Device.lastSeenAt を更新する read 経路を
 * 通すこと、Device 更新が失敗しても heartbeat 応答（active/pinRequired/authorized）を
 * 壊さないこと（best-effort）を検証する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getKioskConfig = vi.fn();
const getSecuritySettings = vi.fn();
const readKioskSession = vi.fn();
const recordHeartbeat = vi.fn();
const cookieGet = vi.fn(() => ({ value: 'kiosk-cookie' }));

vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }));
vi.mock('@/lib/kiosk/kiosk-store', () => ({
  getKioskConfig: (...a: unknown[]) => getKioskConfig(...a),
}));
vi.mock('@/lib/security/security-store', () => ({
  getSecuritySettings: (...a: unknown[]) => getSecuritySettings(...a),
}));
vi.mock('@/domain/security/types', () => ({
  effectiveKioskActive: (active: boolean, emergencyStop: boolean) => active && !emergencyStop,
}));
vi.mock('@/lib/auth/kiosk', () => ({
  KIOSK_COOKIE: 'kiosk_session',
  readKioskSession: (...a: unknown[]) => readKioskSession(...a),
}));
vi.mock('@/lib/tenant/store', () => ({
  getDeviceService: () => ({ recordHeartbeat: (...a: unknown[]) => recordHeartbeat(...a) }),
}));

import { GET } from './route';

function call(kioskId = 'kiosk-dev') {
  return GET(new Request(`http://localhost/api/kiosk/heartbeat?kioskId=${kioskId}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  getKioskConfig.mockResolvedValue({ kioskId: 'kiosk-dev', active: true });
  getSecuritySettings.mockResolvedValue({ emergencyStop: false, pinRequired: false });
  readKioskSession.mockResolvedValue({ kioskId: 'kiosk-dev' });
  recordHeartbeat.mockResolvedValue({ matched: true });
});

describe('GET /api/kiosk/heartbeat (#87 inc3 Kiosk→Device)', () => {
  it('kiosk id で Device.lastSeenAt 更新を呼ぶ', async () => {
    await call('kiosk-dev');
    expect(recordHeartbeat).toHaveBeenCalledWith('kiosk-dev');
  });

  it('Device 更新に失敗しても heartbeat 応答は返る（best-effort）', async () => {
    recordHeartbeat.mockRejectedValue(new Error('backend down'));
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.active).toBe(true);
    expect(body.pinRequired).toBe(false);
    expect(body.authorized).toBe(true);
  });

  it('応答形は従来どおり（active/pinRequired/authorized/serverTime）', async () => {
    const res = await call();
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      ['active', 'authorized', 'pinRequired', 'serverTime'].sort(),
    );
  });
});
