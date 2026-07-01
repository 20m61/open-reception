/**
 * POST /api/platform/maintenance（メンテナンス登録）の JIT 昇格ゲート・検証・監査 (issue #83 inc4c)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import type { MaintenanceWindow } from '@/domain/platform/maintenance-window';
import { grantElevation } from '@/domain/auth/elevation';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const cookieGet = vi.fn<(name: string) => { value: string } | undefined>();
const createMaintenanceWindow = vi.fn<(w: MaintenanceWindow) => Promise<void>>();
const recordDangerAction = vi.fn<(i: unknown) => Promise<unknown>>();

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
  resolveAdminActorWithIdentity: async () => {
    const a = await resolveAdminActor();
    return a ? { actor: a, identity: 'dev@example.com' } : null;
  },
}));
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve({ get: (n: string) => cookieGet(n) }) }));
vi.mock('@/lib/platform/maintenance-window-store', () => ({
  listMaintenanceWindows: vi.fn().mockResolvedValue([]),
  createMaintenanceWindow: (w: MaintenanceWindow) => createMaintenanceWindow(w),
}));
vi.mock('@/lib/admin/audit', () => ({ recordDangerAction: (i: unknown) => recordDangerAction(i) }));

import { POST } from './route';
import { issueElevationToken, ELEVATION_COOKIE } from '@/lib/platform/elevation';

function developer(): Actor {
  return { status: 'active', assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }] };
}
async function elevate(): Promise<void> {
  const token = await issueElevationToken(grantElevation({ reason: 'メンテ登録のため', scope: {} }, Date.now()), 'j', 'dev@example.com');
  cookieGet.mockImplementation((n) => (n === ELEVATION_COOKIE ? { value: token } : undefined));
}
function post(body: unknown): Promise<Response> {
  return POST(new Request('http://x/api/platform/maintenance', { method: 'POST', body: JSON.stringify(body) }));
}

const VALID = {
  scope: 'platform',
  impact: 'limited',
  message: '定期メンテナンス',
  startsAt: '2026-07-10T00:00:00.000Z',
  endsAt: '2026-07-10T02:00:00.000Z',
  reason: '計画停止',
};

beforeEach(() => {
  vi.clearAllMocks();
  cookieGet.mockReturnValue(undefined);
  resolveAdminActor.mockResolvedValue(developer());
});

describe('POST /api/platform/maintenance (#83)', () => {
  it('未認証は 401', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await post(VALID)).status).toBe(401);
    expect(createMaintenanceWindow).not.toHaveBeenCalled();
  });

  it('developer でも未昇格は 403 elevation_required', async () => {
    const res = await post(VALID);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('elevation_required');
    expect(createMaintenanceWindow).not.toHaveBeenCalled();
  });

  it('昇格済みでも不正入力（endsAt<=startsAt）は 400', async () => {
    await elevate();
    expect((await post({ ...VALID, endsAt: VALID.startsAt })).status).toBe(400);
    expect(createMaintenanceWindow).not.toHaveBeenCalled();
  });

  it('昇格済みは登録でき、201 + 保存 + 監査（理由つき）が残る', async () => {
    await elevate();
    const res = await post(VALID);
    expect(res.status).toBe(201);
    expect(createMaintenanceWindow).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'platform', impact: 'limited', status: 'scheduled' }),
    );
    expect(recordDangerAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'platform.maintenance.scheduled', reason: '計画停止' }),
    );
    expect('createdBy' in (await res.json()).window).toBe(false);
  });

  it('登録は必ず scheduled（client の status は無視される）', async () => {
    await elevate();
    await post({ ...VALID, status: 'active' });
    expect(createMaintenanceWindow).toHaveBeenCalledWith(expect.objectContaining({ status: 'scheduled' }));
  });

  it('store 失敗時は 500 + 補償監査（audit-first の phantom を明示）', async () => {
    await elevate();
    createMaintenanceWindow.mockRejectedValueOnce(new Error('backend down'));
    const res = await post(VALID);
    expect(res.status).toBe(500);
    // 先の「登録」監査 + 補償（store_failed）監査の 2 回。
    expect(recordDangerAction).toHaveBeenCalledTimes(2);
    expect(recordDangerAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ metadata: { result: 'store_failed' } }),
    );
  });
});
