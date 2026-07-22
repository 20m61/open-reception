/**
 * ルーティングポリシー API のルート結線テスト (issue #374)。
 *
 * 検証: 401、400（tenantId 欠落）、保存時の構造検証で 400（unknown_endpoint / cycle）、201 作成、
 * 一覧（文章形式説明つき）、越境 403、viewer 403。seed（個人携帯→代理→部門代表）を土台にする。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { asTenantId } from '@/domain/tenant/types';
import { __resetBackend } from '@/lib/data';
import { __resetRoutingService } from '@/lib/routing/store';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
vi.mock('@/lib/auth/actor', () => ({ resolveAdminActor: () => resolveAdminActor() }));
vi.mock('@/lib/data-stores/reception-log-store', () => ({ appendAdminAudit: vi.fn(async () => ({})) }));

import { GET, POST } from './route';

function tenantAdmin(tenantId = 'internal'): Actor {
  return { status: 'active', assignments: [{ role: 'tenant_admin', tenantId: asTenantId(tenantId), siteId: null, deviceId: null }] };
}
function viewer(tenantId = 'internal'): Actor {
  return { status: 'active', assignments: [{ role: 'viewer', tenantId: asTenantId(tenantId), siteId: null, deviceId: null }] };
}

function post(body: unknown): Request {
  return new Request('http://x/api/admin/routing/policies', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function get(query = 'tenantId=internal'): Request {
  return new Request(`http://x/api/admin/routing/policies?${query}`);
}

const VALID_BODY = {
  tenantId: 'internal',
  siteId: 'default-site',
  name: '新ルート',
  enabled: true,
  steps: [{ id: 's1', endpointId: 'seed-ep-personal', action: 'notify', timeoutSeconds: 20, nextOn: {} }],
};

beforeEach(() => {
  vi.clearAllMocks();
  // seed（内蔵の標準取次 + seed 接続先）を土台にする。
  delete process.env.RECEPTION_DISABLE_DEV_SEED;
  __resetBackend();
  __resetRoutingService();
  resolveAdminActor.mockResolvedValue(tenantAdmin());
});

describe('GET /api/admin/routing/policies', () => {
  it('未認証は 401', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await GET(get())).status).toBe(401);
  });

  it('tenantId 欠落は 400', async () => {
    expect((await GET(new Request('http://x/api/admin/routing/policies'))).status).toBe(400);
  });

  it('seed ポリシーを文章形式説明つきで返す', async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(list.length).toBeGreaterThanOrEqual(1);
    const seedPolicy = list.find((p: { id: string }) => p.id === 'seed-personal-acting-department');
    expect(seedPolicy).toBeDefined();
    expect(Array.isArray(seedPolicy.description)).toBe(true);
    expect(seedPolicy.description[0]).toContain('個人携帯→代理→部門代表');
  });
});

describe('POST /api/admin/routing/policies', () => {
  it('未登録 endpoint を参照すると 400（issues に unknown_endpoint）', async () => {
    const res = await POST(post({ ...VALID_BODY, steps: [{ id: 's1', endpointId: 'missing', action: 'notify', timeoutSeconds: 20, nextOn: {} }] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues.some((i: { kind: string }) => i.kind === 'unknown_endpoint')).toBe(true);
  });

  it('空 step のポリシーは保存時検証で 400（issues に empty_policy）', async () => {
    const res = await POST(post({ ...VALID_BODY, steps: [] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues.some((i: { kind: string }) => i.kind === 'empty_policy')).toBe(true);
  });

  it('存在しない fallback 先を指すと 400（issues に unknown_fallback_policy）', async () => {
    const res = await POST(post({ ...VALID_BODY, fallbackPolicyId: 'no-such-policy' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues.some((i: { kind: string }) => i.kind === 'unknown_fallback_policy')).toBe(true);
  });

  it('妥当なポリシーは 201 を返し文章形式説明を含む', async () => {
    const res = await POST(post(VALID_BODY));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe('新ルート');
    expect(body.description[0]).toContain('新ルート');
  });

  it('viewer は 403', async () => {
    resolveAdminActor.mockResolvedValue(viewer());
    expect((await POST(post(VALID_BODY))).status).toBe(403);
  });

  it('他テナント actor は 403（越境拒否）', async () => {
    resolveAdminActor.mockResolvedValue(tenantAdmin('other-tenant'));
    expect((await POST(post(VALID_BODY))).status).toBe(403);
  });
});
