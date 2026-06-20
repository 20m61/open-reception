import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { asTenantId } from '@/domain/tenant/types';

// resolveAdminActor を差し替えてアクセス制御だけを検証する（cookie/Entra は actor.ts のテスト範囲）。
const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
vi.mock('@/lib/auth/actor', () => ({ resolveAdminActor: () => resolveAdminActor() }));

const { resolveUsageScope } = await import('./request');

function params(tenantId?: string): URLSearchParams {
  const p = new URLSearchParams();
  if (tenantId) p.set('tenantId', tenantId);
  return p;
}

function actorFor(tenantId: string): Actor {
  return {
    status: 'active',
    assignments: [{ role: 'tenant_admin', tenantId: asTenantId(tenantId), siteId: null, deviceId: null }],
  };
}

describe('resolveUsageScope (#89 アクセス制御)', () => {
  beforeEach(() => resolveAdminActor.mockReset());

  it('未認証は 401', async () => {
    resolveAdminActor.mockResolvedValue(null);
    const r = await resolveUsageScope(params('t1'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it('tenantId 未指定は 400', async () => {
    resolveAdminActor.mockResolvedValue(actorFor('t1'));
    const r = await resolveUsageScope(params());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(400);
  });

  it('自テナントは許可される', async () => {
    resolveAdminActor.mockResolvedValue(actorFor('t1'));
    const r = await resolveUsageScope(params('t1'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tenantId).toBe(asTenantId('t1'));
  });

  it('他テナント参照は 403（他テナントの利用量・コストが返らない）', async () => {
    resolveAdminActor.mockResolvedValue(actorFor('t1'));
    const r = await resolveUsageScope(params('t2'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });

  it('developer は横断閲覧できる', async () => {
    resolveAdminActor.mockResolvedValue({
      status: 'active',
      assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }],
    });
    const r = await resolveUsageScope(params('any-tenant'));
    expect(r.ok).toBe(true);
  });
});
