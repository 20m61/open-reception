/**
 * アップデート状況 API の認可境界・射影テスト (issue #83 AC6)。
 *   - 未認証 → 401 / 非 developer → 403 / developer → 200。
 *   - 集計（pending 優先・件数）を返し、操作者識別子（updatedBy）は載せない。
 *   - 対象テナント選択 Cookie で全体影響＋選択テナントに絞る。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { asTenantId } from '@/domain/tenant/types';
import type { UpdateStatus } from '@/domain/platform/update-status';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const listUpdateStatuses = vi.fn<() => Promise<UpdateStatus[]>>();
const cookieGet = vi.fn<() => { value: string } | undefined>(() => undefined);

vi.mock('@/lib/auth/actor', () => ({ resolveAdminActor: () => resolveAdminActor() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: cookieGet }) }));
vi.mock('@/lib/platform/update-status-store', () => ({
  listUpdateStatuses: () => listUpdateStatuses(),
}));

import { GET } from './route';

function developer(): Actor {
  return { status: 'active', assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }] };
}
function tenantAdmin(): Actor {
  return {
    status: 'active',
    assignments: [{ role: 'tenant_admin', tenantId: asTenantId('internal'), siteId: null, deviceId: null }],
  };
}

function upd(over: Partial<UpdateStatus>): UpdateStatus {
  return {
    id: 'u1',
    scope: 'device',
    component: 'kiosk-app',
    currentVersion: '1.0.0',
    latestVersion: '1.0.0',
    state: 'up_to_date',
    checkedAt: '2026-06-20T00:00:00.000Z',
    updatedBy: 'platform:ops@example.com',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieGet.mockReturnValue(undefined);
  listUpdateStatuses.mockResolvedValue([
    upd({ id: 'plat', scope: 'platform', state: 'up_to_date' }),
    upd({ id: 'ten', scope: 'tenant', tenantId: 'internal', state: 'update_available' }),
    upd({ id: 'other', scope: 'tenant', tenantId: 'acme', state: 'failed' }),
  ]);
});

describe('GET /api/platform/updates', () => {
  it('未認証は 401', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it('非 developer は 403', async () => {
    resolveAdminActor.mockResolvedValue(tenantAdmin());
    expect((await GET()).status).toBe(403);
  });

  it('developer は集計を返し、updatedBy は載せない', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      updates: { pendingCount: number; totalCount: number; updates: Record<string, unknown>[] };
    };
    expect(body.updates.totalCount).toBe(3);
    expect(body.updates.pendingCount).toBe(2);
    for (const row of body.updates.updates) {
      expect('updatedBy' in row).toBe(false);
    }
  });

  it('対象テナント選択 Cookie で全体影響＋選択テナントに絞る', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    cookieGet.mockReturnValue({ value: 'internal' });
    const res = await GET();
    const body = (await res.json()) as { updates: { updates: { id: string }[] } };
    // platform（全体影響）と internal は残り、acme は落ちる。
    expect(body.updates.updates.map((r) => r.id).sort()).toEqual(['plat', 'ten']);
  });
});
