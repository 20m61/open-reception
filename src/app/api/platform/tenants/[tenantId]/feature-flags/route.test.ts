/**
 * テナント別機能フラグ API（/api/platform/tenants/[tenantId]/feature-flags）のテスト (issue #83 inc5a)。
 * read は developer 専用、write は JIT 昇格必須（対象テナントを覆う昇格）であること、
 * テナント実在チェック（#268 の型）、永続化と監査（feature_flag.updated, before/after つき）を検証する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { asTenantId, type Tenant } from '@/domain/tenant/types';
import type { AuditAction } from '@/domain/reception/log';
import type { TenantFeatureFlagRecord } from '@/domain/platform/feature-flags';
import { grantElevation } from '@/domain/auth/elevation';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const getTenant = vi.fn<(id: unknown) => Promise<Tenant | undefined>>();
const cookieGet = vi.fn<(name: string) => { value: string } | undefined>();
const getRecord = vi.fn<(tenantId: string) => Promise<TenantFeatureFlagRecord | undefined>>();
const putRecord = vi.fn<(record: TenantFeatureFlagRecord) => Promise<void>>();
const recordDangerAction =
  vi.fn<
    (input: {
      action: AuditAction;
      target: unknown;
      reason?: string;
      metadata?: unknown;
      before?: unknown;
      after?: unknown;
      actor?: string;
      request?: Request;
    }) => Promise<unknown>
  >();

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
  resolveAdminActorWithIdentity: async () => {
    const a = await resolveAdminActor();
    return a ? { actor: a, identity: 'dev@example.com' } : null;
  },
}));
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve({ get: (n: string) => cookieGet(n) }) }));
vi.mock('@/lib/tenant/store', () => ({
  getTenantStore: () => ({ tenants: { getTenant: (id: unknown) => getTenant(id) } }),
}));
vi.mock('@/lib/platform/feature-flag-store', () => ({
  getTenantFeatureFlagRecord: (tenantId: string) => getRecord(tenantId),
  putTenantFeatureFlagRecord: (record: TenantFeatureFlagRecord) => putRecord(record),
}));
vi.mock('@/lib/admin/audit', () => ({ recordDangerAction: (i: unknown) => recordDangerAction(i as never) }));

import { GET, PATCH } from './route';
import { issueElevationToken, ELEVATION_COOKIE } from '@/lib/platform/elevation';

/** developer に対象テナントを覆う有効な昇格 cookie を持たせる。 */
async function grantCookie(scope: { tenantId?: string } = {}): Promise<void> {
  const token = await issueElevationToken(
    grantElevation({ reason: '機能フラグ変更のため', scope }, Date.now()),
    'j',
    'dev@example.com',
  );
  cookieGet.mockImplementation((n) => (n === ELEVATION_COOKIE ? { value: token } : undefined));
}

function developer(): Actor {
  return { status: 'active', assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }] };
}
function tenantAdmin(): Actor {
  return { status: 'active', assignments: [{ role: 'tenant_admin', tenantId: asTenantId('internal'), siteId: null, deviceId: null }] };
}

const TENANT: Tenant = {
  id: asTenantId('internal'),
  name: '社内',
  slug: 'internal',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function get(tenantId = 'internal') {
  const req = new Request(`http://x/api/platform/tenants/${tenantId}/feature-flags`);
  return GET(req, { params: Promise.resolve({ tenantId }) });
}

function patch(body: unknown, tenantId = 'internal') {
  const req = new Request(`http://x/api/platform/tenants/${tenantId}/feature-flags`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return PATCH(req, { params: Promise.resolve({ tenantId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  getTenant.mockResolvedValue({ ...TENANT });
  getRecord.mockResolvedValue(undefined);
  cookieGet.mockReturnValue(undefined); // 既定: 未昇格。
});

describe('GET /api/platform/tenants/[tenantId]/feature-flags (#83 inc5a)', () => {
  it('未認証は 401', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
  });

  it('非 developer は 403（tenant_admin でも platform read は不可）', async () => {
    resolveAdminActor.mockResolvedValue(tenantAdmin());
    expect((await get()).status).toBe(403);
  });

  it('存在しないテナントは 404', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    getTenant.mockResolvedValue(undefined);
    expect((await get('nope')).status).toBe(404);
  });

  it('上書き未作成のテナントは既定値（全機能有効）を返す', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenantId).toBe('internal');
    expect(body.flags).toEqual({ voiceSynthesis: true, avatarReception: true });
  });

  it('保存済み上書きを反映した実効値を返す', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    getRecord.mockResolvedValue({
      id: 'internal',
      flags: { voiceSynthesis: false },
      updatedAt: '2026-06-01T00:00:00.000Z',
    });
    const body = await (await get()).json();
    expect(body.flags).toEqual({ voiceSynthesis: false, avatarReception: true });
    expect(body.updatedAt).toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('PATCH /api/platform/tenants/[tenantId]/feature-flags (#83 inc5a / JIT #83 AC5)', () => {
  it('未認証は 401', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await patch({ flags: { voiceSynthesis: false } })).status).toBe(401);
  });

  it('非 developer は 403', async () => {
    resolveAdminActor.mockResolvedValue(tenantAdmin());
    expect((await patch({ flags: { voiceSynthesis: false } })).status).toBe(403);
  });

  it('developer でも未昇格は 403 elevation_required（機能制限の変更は昇格必須, #83 §1）', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    const res = await patch({ flags: { voiceSynthesis: false }, reason: 'x' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('elevation_required');
    expect(putRecord).not.toHaveBeenCalled();
    expect(recordDangerAction).not.toHaveBeenCalled();
  });

  it('別テナントのみを覆う昇格では 403（対象テナントの明示昇格が要る）', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    await grantCookie({ tenantId: 'other' });
    const res = await patch({ flags: { voiceSynthesis: false } });
    expect(res.status).toBe(403);
    expect(putRecord).not.toHaveBeenCalled();
  });

  it('不正な flags（未知キー / 非 boolean / 空）は 400（昇格済み）', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    await grantCookie();
    expect((await patch({ flags: { unknownFlag: false } })).status).toBe(400);
    expect((await patch({ flags: { voiceSynthesis: 'off' } })).status).toBe(400);
    expect((await patch({ flags: {} })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect(putRecord).not.toHaveBeenCalled();
  });

  it('存在しないテナントは 404（typo への write を拒否, #268 の型）', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    await grantCookie();
    getTenant.mockResolvedValue(undefined);
    expect((await patch({ flags: { voiceSynthesis: false } }, 'nope')).status).toBe(404);
    expect(putRecord).not.toHaveBeenCalled();
  });

  it('昇格済み developer は無効化でき、永続化と監査（before/after・操作者帰属つき）が残る', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    await grantCookie({ tenantId: 'internal' });
    const res = await patch({ flags: { voiceSynthesis: false }, reason: 'PoC プランのため' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flags).toEqual({ voiceSynthesis: false, avatarReception: true });
    expect(putRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'internal',
        flags: expect.objectContaining({ voiceSynthesis: false }),
        updatedBy: 'dev@example.com',
      }),
    );
    expect(recordDangerAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'feature_flag.updated',
        target: { type: 'tenant', id: 'internal' },
        reason: 'PoC プランのため',
        before: { voiceSynthesis: 'true' },
        after: { voiceSynthesis: 'false' },
        actor: 'platform:dev@example.com',
        request: expect.any(Request),
      }),
    );
  });

  it('実効値が変わらない変更（no-op）は保存も監査もせず現状を返す', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    await grantCookie();
    const res = await patch({ flags: { voiceSynthesis: true } });
    expect(res.status).toBe(200);
    expect((await res.json()).flags).toEqual({ voiceSynthesis: true, avatarReception: true });
    expect(putRecord).not.toHaveBeenCalled();
    expect(recordDangerAction).not.toHaveBeenCalled();
  });

  it('保存失敗時は 500 で、監査に store_failed の跡を残す', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    await grantCookie();
    putRecord.mockRejectedValue(new Error('boom'));
    const res = await patch({ flags: { voiceSynthesis: false }, reason: 'x' });
    expect(res.status).toBe(500);
    expect(recordDangerAction).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ result: 'store_failed' }) }),
    );
  });
});
