/**
 * kiosk heartbeat ルートの単体テスト。
 *
 * Kiosk→Device 統合 (issue #87 inc3): heartbeat が Device.lastSeenAt を更新する read 経路を
 * 通すこと、Device 更新が失敗しても heartbeat 応答（active/pinRequired/authorized）を
 * 壊さないこと（best-effort）を検証する。
 *
 * #261: 対応 Device が無い kiosk（旧レジストリのみの端末）は、kiosk レジストリでの実在を
 * 確認したうえで Device へ取り込む（adoptKiosk）。未登録 id では取り込まない
 * （無認可 heartbeat からの任意行作成を防ぐ）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getKioskConfig = vi.fn();
const getKiosk = vi.fn();
const getSecuritySettings = vi.fn();
const readKioskSession = vi.fn();
const recordHeartbeat = vi.fn();
const adoptKiosk = vi.fn();
const cookieGet = vi.fn(() => ({ value: 'kiosk-cookie' }));
const SCOPE = { tenantId: 'internal', siteId: 'default-site' };

vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }));
vi.mock('@/lib/kiosk/kiosk-store', () => ({
  getKioskConfig: (...a: unknown[]) => getKioskConfig(...a),
  getKiosk: (...a: unknown[]) => getKiosk(...a),
}));
vi.mock('@/lib/tenant/default-scope', () => ({
  resolveDefaultScope: () => SCOPE,
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
  getDeviceService: () => ({
    recordHeartbeat: (...a: unknown[]) => recordHeartbeat(...a),
    adoptKiosk: (...a: unknown[]) => adoptKiosk(...a),
  }),
}));

import { GET } from './route';

function call(kioskId = 'kiosk-dev') {
  return GET(new Request(`http://localhost/api/kiosk/heartbeat?kioskId=${kioskId}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  getKioskConfig.mockResolvedValue({ kioskId: 'kiosk-dev', active: true });
  getKiosk.mockResolvedValue({
    ok: true,
    value: { id: 'kiosk-dev', displayName: '受付端末1', enabled: true },
  });
  getSecuritySettings.mockResolvedValue({ emergencyStop: false, pinRequired: false });
  readKioskSession.mockResolvedValue({ kioskId: 'kiosk-dev' });
  recordHeartbeat.mockResolvedValue({ matched: true });
  adoptKiosk.mockResolvedValue({ created: true });
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

  it('Device 一致時は取り込み（adoptKiosk）を呼ばない', async () => {
    await call('kiosk-dev');
    expect(adoptKiosk).not.toHaveBeenCalled();
  });
});

describe('GET /api/kiosk/heartbeat (#261 kiosk-only 端末の Device 取り込み)', () => {
  it('対応 Device が無く kiosk レジストリに実在する端末は Device へ取り込む', async () => {
    recordHeartbeat.mockResolvedValue({ matched: false });
    readKioskSession.mockResolvedValue({ kioskId: 'kiosk-legacy' });
    getKiosk.mockResolvedValue({
      ok: true,
      value: { id: 'kiosk-legacy', displayName: '旧端末', enabled: true },
    });
    const res = await call('kiosk-legacy');
    expect(res.status).toBe(200);
    expect(getKiosk).toHaveBeenCalledWith('kiosk-legacy');
    expect(adoptKiosk).toHaveBeenCalledWith(
      { id: 'kiosk-legacy', displayName: '旧端末', enabled: true },
      SCOPE,
    );
  });

  it('kiosk レジストリに無い id は取り込まない（無認可の任意行作成を防ぐ）', async () => {
    recordHeartbeat.mockResolvedValue({ matched: false });
    readKioskSession.mockResolvedValue({ kioskId: 'kiosk-unknown' });
    getKiosk.mockResolvedValue({ ok: false, error: { code: 'not_found', message: 'x' } });
    await call('kiosk-unknown');
    expect(adoptKiosk).not.toHaveBeenCalled();
  });

  it('空 kioskId は kiosk レジストリを引かない（DynamoDB の空 SK を避ける既存規約）', async () => {
    recordHeartbeat.mockResolvedValue({ matched: false });
    await call('');
    expect(getKiosk).not.toHaveBeenCalled();
    expect(adoptKiosk).not.toHaveBeenCalled();
  });

  it('取り込みに失敗しても heartbeat 応答は返る（best-effort）', async () => {
    recordHeartbeat.mockResolvedValue({ matched: false });
    readKioskSession.mockResolvedValue({ kioskId: 'kiosk-legacy' });
    adoptKiosk.mockRejectedValue(new Error('backend down'));
    const res = await call('kiosk-legacy');
    expect(res.status).toBe(200);
    expect((await res.json()).active).toBe(true);
  });
});

describe('GET /api/kiosk/heartbeat (#284 inc1 死活記録のセッション紐づけ)', () => {
  it('kiosk セッションが無いリクエストは死活を記録しない（偽 online 注入対策）', async () => {
    readKioskSession.mockResolvedValue(null);
    const res = await call('kiosk-dev');
    expect(recordHeartbeat).not.toHaveBeenCalled();
    expect(adoptKiosk).not.toHaveBeenCalled();
    // 応答は既存互換: 端末の失効検知/緊急停止検知は従来どおり返す。
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.active).toBe(true);
    expect(body.authorized).toBe(false);
  });

  it('セッションの kioskId とクエリの kioskId が不一致なら記録をスキップする', async () => {
    readKioskSession.mockResolvedValue({ kioskId: 'kiosk-other' });
    const res = await call('kiosk-dev');
    expect(recordHeartbeat).not.toHaveBeenCalled();
    expect(adoptKiosk).not.toHaveBeenCalled();
    // authorized は「有効な kiosk セッションを保持しているか」の既存意味を維持する。
    expect((await res.json()).authorized).toBe(true);
  });

  it('セッションの kioskId と一致するリクエストのみ死活を記録する', async () => {
    readKioskSession.mockResolvedValue({ kioskId: 'kiosk-dev' });
    await call('kiosk-dev');
    expect(recordHeartbeat).toHaveBeenCalledWith('kiosk-dev');
  });

  it('セッション不一致でも kiosk-only 端末の取り込み（adoptKiosk）は行わない', async () => {
    recordHeartbeat.mockResolvedValue({ matched: false });
    readKioskSession.mockResolvedValue(null);
    await call('kiosk-legacy');
    expect(getKiosk).not.toHaveBeenCalled();
    expect(adoptKiosk).not.toHaveBeenCalled();
  });
});
