/**
 * 認証・外部連携・シークレット状態 API の単体テスト (issue #93)。
 * 認可境界（未認証 401 / viewer 書込 403 / tenant_admin 書込 200）・
 * 平文非露出・状態遷移・監査記録を検証する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { asTenantId, asSiteId } from '@/domain/tenant/types';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const appendAdminAudit = vi.fn();

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
}));
vi.mock('@/lib/data-stores/reception-log-store', () => ({
  appendAdminAudit: (...a: unknown[]) => appendAdminAudit(...a),
}));

import { GET } from './route';
import { POST as TEST } from './test/route';
import { PUT as SECRET_PUT, DELETE as SECRET_DELETE } from './secrets/route';
import { __resetIntegrationStatus } from '@/lib/security/integration-status-store';

const TENANT = 'internal';

function tenantAdmin(): Actor {
  return { status: 'active', assignments: [{ role: 'tenant_admin', tenantId: asTenantId(TENANT), siteId: null, deviceId: null }] };
}
function viewer(): Actor {
  return { status: 'active', assignments: [{ role: 'viewer', tenantId: asTenantId(TENANT), siteId: null, deviceId: null }] };
}
function otherTenantAdmin(): Actor {
  return { status: 'active', assignments: [{ role: 'tenant_admin', tenantId: asTenantId('other'), siteId: asSiteId('s'), deviceId: null }] };
}

function getReq(tenantId = TENANT) {
  return new Request(`http://localhost/api/admin/integrations?tenantId=${tenantId}`);
}
function postReq(url: string, body: unknown) {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function bodyReq(url: string, method: string, body: unknown) {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const SECRET_ENV = ['VONAGE_API_SECRET', 'VONAGE_PRIVATE_KEY', 'VONAGE_ENABLED'];
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  vi.clearAllMocks();
  for (const k of SECRET_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  await __resetIntegrationStatus();
});

afterEach(() => {
  for (const k of SECRET_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('GET /api/admin/integrations', () => {
  it('401 when no admin session', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await GET(getReq())).status).toBe(401);
  });

  it('400 when tenantId is missing', async () => {
    resolveAdminActor.mockResolvedValue(tenantAdmin());
    expect((await GET(new Request('http://localhost/api/admin/integrations'))).status).toBe(400);
  });

  it('403 when actor cannot access the tenant (cross-tenant isolation)', async () => {
    resolveAdminActor.mockResolvedValue(otherTenantAdmin());
    expect((await GET(getReq(TENANT))).status).toBe(403);
  });

  it('viewer can read (200) and the secret plaintext is never returned', async () => {
    process.env.VONAGE_API_SECRET = 'real-secret-value';
    resolveAdminActor.mockResolvedValue(viewer());
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('real-secret-value');
    const json = JSON.parse(text);
    const apiSecret = json.secrets.find((s: { key: string }) => s.key === 'VONAGE_API_SECRET');
    expect(apiSecret.presence).toBe('configured');
    expect(apiSecret).not.toHaveProperty('value');
  });
});

describe('POST /api/admin/integrations/test', () => {
  it('403 for viewer (write not allowed)', async () => {
    resolveAdminActor.mockResolvedValue(viewer());
    const res = await TEST(postReq('/api/admin/integrations/test', { tenantId: TENANT, id: 'vonage' }));
    expect(res.status).toBe(403);
    expect(appendAdminAudit).not.toHaveBeenCalled();
  });

  it('tenant_admin can run connection test and it is audited', async () => {
    resolveAdminActor.mockResolvedValue(tenantAdmin());
    const res = await TEST(postReq('/api/admin/integrations/test', { tenantId: TENANT, id: 'vonage' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    // 設定が無い環境なので failure。要約に名前は出るが値は出ない。
    expect(json.result).toBe('failure');
    expect(appendAdminAudit).toHaveBeenCalledWith(
      'integration.tested',
      { type: 'integration', id: 'vonage' },
      expect.objectContaining({ result: 'failure' }),
    );
  });

  it('400 for unknown integration', async () => {
    resolveAdminActor.mockResolvedValue(tenantAdmin());
    const res = await TEST(postReq('/api/admin/integrations/test', { tenantId: TENANT, id: 'bogus' }));
    expect(res.status).toBe(400);
  });
});

describe('PUT/DELETE /api/admin/integrations/secrets', () => {
  it('403 for viewer write', async () => {
    resolveAdminActor.mockResolvedValue(viewer());
    const res = await SECRET_PUT(bodyReq('/api/admin/integrations/secrets', 'PUT', { tenantId: TENANT, key: 'WEBHOOK_SECRET' }));
    expect(res.status).toBe(403);
    expect(appendAdminAudit).not.toHaveBeenCalled();
  });

  it('tenant_admin marks secret updated (no value accepted/returned) and audits', async () => {
    resolveAdminActor.mockResolvedValue(tenantAdmin());
    const res = await SECRET_PUT(
      bodyReq('/api/admin/integrations/secrets', 'PUT', {
        tenantId: TENANT,
        key: 'WEBHOOK_SECRET',
        // たとえクライアントが value を送っても無視され、応答に現れない。
        value: 'attacker-supplied-plaintext',
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('attacker-supplied-plaintext');
    const json = JSON.parse(text);
    expect(json).not.toHaveProperty('value');
    expect(json.updatedBy).toBe('tenant_admin');
    expect(appendAdminAudit).toHaveBeenCalledWith('secret.updated', { type: 'secret', id: 'WEBHOOK_SECRET' }, { actor: 'tenant_admin' });
  });

  it('DELETE marks secret as needs_rotation and audits secret.cleared', async () => {
    resolveAdminActor.mockResolvedValue(tenantAdmin());
    const res = await SECRET_DELETE(bodyReq('/api/admin/integrations/secrets', 'DELETE', { tenantId: TENANT, key: 'OAUTH_CLIENT_SECRET' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.health).toBe('needs_rotation');
    expect(appendAdminAudit).toHaveBeenCalledWith('secret.cleared', { type: 'secret', id: 'OAUTH_CLIENT_SECRET' }, { actor: 'tenant_admin' });
  });

  it('400 for unknown secret key', async () => {
    resolveAdminActor.mockResolvedValue(tenantAdmin());
    const res = await SECRET_PUT(bodyReq('/api/admin/integrations/secrets', 'PUT', { tenantId: TENANT, key: 'NOT_A_SECRET' }));
    expect(res.status).toBe(400);
  });

  it('401 when unauthenticated', async () => {
    resolveAdminActor.mockResolvedValue(null);
    const res = await SECRET_PUT(bodyReq('/api/admin/integrations/secrets', 'PUT', { tenantId: TENANT, key: 'WEBHOOK_SECRET' }));
    expect(res.status).toBe(401);
  });
});
