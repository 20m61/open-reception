/**
 * GET /api/kiosk/config のテスト (#18/#29 + #290 item3 メンテナンス enforcement + #367 営業時間外)。
 *
 * - 通常時は端末設定 + active（緊急停止を factor 済み）を返し maintenance=null。
 * - impact=unavailable の現在有効メンテでは active=false（受付開始を止める）。
 * - read_only 等の軽い影響では active を維持し、案内表示用に maintenance を返す。
 * - 判定不能（fail-open）では maintenance=null・active は既存ロジックのまま。
 * - #367: 保存済みポリシーの判定結果を operatingStatus として返す。未設定/判定不能は null。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getKioskConfig = vi.fn();
const getSecuritySettings = vi.fn();
const resolveKioskMaintenance = vi.fn();
const resolveKioskOperatingStatusById = vi.fn();
const requireKioskSession = vi.fn();

vi.mock('@/lib/kiosk/kiosk-store', () => ({
  getKioskConfig: (...a: unknown[]) => getKioskConfig(...a),
}));
vi.mock('@/lib/security/security-store', () => ({
  getSecuritySettings: (...a: unknown[]) => getSecuritySettings(...a),
}));
vi.mock('@/lib/platform/maintenance-gate', () => ({
  resolveKioskMaintenance: (...a: unknown[]) => resolveKioskMaintenance(...a),
}));
vi.mock('@/lib/operating-policy/kiosk-gate', () => ({
  resolveKioskOperatingStatusById: (...a: unknown[]) => resolveKioskOperatingStatusById(...a),
}));
// **kioskId はセッション由来**になった (#601)。クエリで任意端末を指定できると、無認証と
// 相まって任意端末の設定・メンテナンス状態・営業状態が列挙できる。
vi.mock('@/lib/kiosk/session-guard', () => ({
  requireKioskSession: () => requireKioskSession(),
}));

import { GET } from './route';

/** セッションの kioskId を差し替える（リクエスト引数はもう受け取らない）。 */
const asKiosk = (kioskId: string) => {
  requireKioskSession.mockResolvedValue({ kioskId });
};

beforeEach(() => {
  vi.clearAllMocks();
  getKioskConfig.mockResolvedValue({ kioskId: 'kiosk-1', displayName: '受付端末1', active: true });
  getSecuritySettings.mockResolvedValue({ emergencyStop: false });
  resolveKioskMaintenance.mockResolvedValue(null);
  resolveKioskOperatingStatusById.mockResolvedValue(undefined);
  requireKioskSession.mockResolvedValue({ kioskId: 'kiosk-1' });
});

describe('GET /api/kiosk/config (#290 item3)', () => {
  it('通常時は設定 + active=true・maintenance=null・operatingStatus=null を返す', async () => {
    const res = (asKiosk('kiosk-1'), await GET());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      kioskId: 'kiosk-1',
      displayName: '受付端末1',
      active: true,
      maintenance: null,
      operatingStatus: null,
    });
    expect(resolveKioskMaintenance).toHaveBeenCalledWith('kiosk-1');
  });

  it('impact=unavailable の現在有効メンテでは active=false にする', async () => {
    resolveKioskMaintenance.mockResolvedValue({
      impact: 'unavailable',
      message: '緊急メンテナンス中',
      endsAt: '2026-07-01T16:00:00.000Z',
    });
    const res = (asKiosk('kiosk-1'), await GET());
    const body = await res.json();
    expect(body.active).toBe(false);
    expect(body.maintenance).toEqual({
      impact: 'unavailable',
      message: '緊急メンテナンス中',
      endsAt: '2026-07-01T16:00:00.000Z',
    });
  });

  it('read_only の軽い影響では active を維持し maintenance を返す', async () => {
    resolveKioskMaintenance.mockResolvedValue({
      impact: 'read_only',
      message: '定期メンテナンス（受付は読み取り専用）',
      endsAt: '2026-07-01T16:00:00.000Z',
    });
    const res = (asKiosk('kiosk-1'), await GET());
    const body = await res.json();
    expect(body.active).toBe(true);
    expect(body.maintenance.impact).toBe('read_only');
  });

  it('緊急停止中はメンテ無しでも active=false（既存ロジックを維持）', async () => {
    getSecuritySettings.mockResolvedValue({ emergencyStop: true });
    const res = (asKiosk('kiosk-1'), await GET());
    await expect(res.json()).resolves.toMatchObject({ active: false, maintenance: null });
  });
});

describe('GET /api/kiosk/config — operatingStatus (#367)', () => {
  it('保存済みポリシーが closed 判定なら operatingStatus をそのまま応答へ含める', async () => {
    resolveKioskOperatingStatusById.mockResolvedValue({
      state: 'closed',
      reopenAt: '2026-07-23T00:00:00.000Z',
      emergencyContactLabel: '警備室内線',
    });
    const res = (asKiosk('kiosk-1'), await GET());
    const body = await res.json();
    expect(body.operatingStatus).toEqual({
      state: 'closed',
      reopenAt: '2026-07-23T00:00:00.000Z',
      emergencyContactLabel: '警備室内線',
    });
    expect(resolveKioskOperatingStatusById).toHaveBeenCalledWith('kiosk-1');
    // 営業時間外でも kiosk 自体の active（端末失効/緊急停止/メンテナンス）は独立して評価される。
    expect(body.active).toBe(true);
  });

  it('ポリシー未設定（fail-open）は operatingStatus=null を返す', async () => {
    resolveKioskOperatingStatusById.mockResolvedValue(undefined);
    const res = (asKiosk('kiosk-1'), await GET());
    const body = await res.json();
    expect(body.operatingStatus).toBeNull();
  });
});

/**
 * セッションが無ければ何も返さない (#601)。以前は無認証で、しかも kioskId をクエリで
 * 受けていたため、**任意端末の設定を列挙できた**。
 */
describe('GET /api/kiosk/config / セッション必須 (#601)', () => {
  it('kiosk セッションが無ければ 403', async () => {
    requireKioskSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it('設定の読み出しはセッションの kioskId で行う（クエリでは指定できない）', async () => {
    requireKioskSession.mockResolvedValue({ kioskId: 'kiosk-mine' });
    await GET();
    expect(getKioskConfig).toHaveBeenCalledWith('kiosk-mine');
  });
});
