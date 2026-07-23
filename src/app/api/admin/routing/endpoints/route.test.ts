/**
 * 接続先 API のルート結線テスト (issue #374)。
 *
 * 検証: 401（未認証）、400（tenantId 欠落）、201 作成、一覧、越境 403、viewer 403。
 * PII: レスポンスにアドレス（e164）が出ないこと（maskedAddress のみ）。
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
  return new Request('http://x/api/admin/routing/endpoints', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function get(query = 'tenantId=internal'): Request {
  return new Request(`http://x/api/admin/routing/endpoints?${query}`);
}

const VALID = {
  tenantId: 'internal',
  ownerType: 'staff',
  ownerId: 'staff-1',
  channel: 'pstn',
  e164: '+81312349999',
  providerKey: 'vonage',
  enabled: true,
  label: '総務代表',
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RECEPTION_DISABLE_DEV_SEED = '1';
  __resetBackend();
  __resetRoutingService();
  resolveAdminActor.mockResolvedValue(tenantAdmin());
});

describe('POST /api/admin/routing/endpoints', () => {
  it('未認証は 401', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await POST(post(VALID))).status).toBe(401);
  });

  it('tenantId 欠落は 400', async () => {
    const { tenantId: _omit, ...rest } = VALID;
    expect((await POST(post(rest))).status).toBe(400);
  });

  it('作成は 201 で maskedAddress のみ返し、e164 を含めない', async () => {
    const res = await POST(post(VALID));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).not.toHaveProperty('e164');
    expect(body.maskedAddress).toBe('****9999');
    expect(body.label).toBe('総務代表');
  });

  it('viewer は 403（書込不可）', async () => {
    resolveAdminActor.mockResolvedValue(viewer());
    expect((await POST(post(VALID))).status).toBe(403);
  });

  it('他テナント actor は 403（越境拒否）', async () => {
    resolveAdminActor.mockResolvedValue(tenantAdmin('other-tenant'));
    expect((await POST(post(VALID))).status).toBe(403);
  });

  it('不正な e164 は 400', async () => {
    expect((await POST(post({ ...VALID, e164: '0312345678' }))).status).toBe(400);
  });
});

describe('GET /api/admin/routing/endpoints', () => {
  it('作成した接続先を一覧に含め、e164 を露出しない', async () => {
    await POST(post(VALID));
    const res = await GET(get());
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('e164');
    expect(list[0].maskedAddress).toBe('****9999');
  });

  it('他テナントの一覧には作成分が現れない（境界フィルタ）', async () => {
    await POST(post(VALID));
    resolveAdminActor.mockResolvedValue(tenantAdmin('other-tenant'));
    const res = await GET(get('tenantId=other-tenant'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
