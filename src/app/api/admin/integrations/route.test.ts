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
import {
  __resetProviderConfigStore,
  putTenantProviderConfig,
} from '@/lib/platform/provider-config-store';
import { __resetTenantSecretStore, getTenantSecretStore } from '@/lib/platform/tenant-secret-store';
import { SecretValue, secretRef } from '@/domain/provider-config/secret';

const TENANT = 'internal';

/** 既定テナントに vonage 設定 + secret を投入し、presence を「設定済み」にする。 */
async function seedVonageTenantConfig(): Promise<void> {
  await putTenantProviderConfig({
    tenantId: TENANT,
    provider: 'vonage',
    enabled: true,
    applicationId: 'app-123',
    updatedAt: '2026-07-01T00:00:00.000Z',
    updatedBy: 'platform:dev',
  });
  await getTenantSecretStore().setSecret(
    secretRef(TENANT, 'vonage'),
    new SecretValue('TEST-vonage-bundle'),
  );
}

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

beforeEach(async () => {
  vi.clearAllMocks();
  await __resetIntegrationStatus();
  __resetProviderConfigStore();
  __resetTenantSecretStore();
});

afterEach(() => {
  __resetProviderConfigStore();
  __resetTenantSecretStore();
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

  it('viewer can read (200): テナント設定+secret で Vonage が設定済み・平文は返らない', async () => {
    await seedVonageTenantConfig();
    resolveAdminActor.mockResolvedValue(viewer());
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const text = await res.text();
    // secret 値は応答に一切現れない。
    expect(text).not.toContain('TEST-vonage-bundle');
    const json = JSON.parse(text);
    // Vonage presence はテナント設定由来で「設定済み・有効」。
    const vonage = json.integrations.find((i: { id: string }) => i.id === 'vonage');
    expect(vonage.configured).toBe(true);
    expect(vonage.enabled).toBe(true);
    // 個別 secret キー一覧に VONAGE は含まれない（テナント設定 presence へ移行済み）。
    expect(json.secrets.some((s: { key: string }) => s.key.startsWith('VONAGE_'))).toBe(false);
  });

  it('viewer can read (200): テナント設定+secret 未設定なら Vonage は未設定(missing)', async () => {
    resolveAdminActor.mockResolvedValue(viewer());
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    const vonage = json.integrations.find((i: { id: string }) => i.id === 'vonage');
    expect(vonage.configured).toBe(false);
    expect(vonage.enabled).toBe(false);
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
    // テナント設定が無い環境なので failure。要約に secret 値・名は出ない。
    expect(json.result).toBe('failure');
    expect(json.summary).not.toMatch(/VONAGE_/);
    expect(json.summary).not.toContain('TEST-vonage-bundle');
    expect(appendAdminAudit).toHaveBeenCalledWith(
      'integration.tested',
      { type: 'integration', id: 'vonage' },
      expect.objectContaining({ result: 'failure' }),
    );
  });

  it('テナント設定+secret 設定済みなら接続テストは success', async () => {
    await seedVonageTenantConfig();
    resolveAdminActor.mockResolvedValue(tenantAdmin());
    const res = await TEST(postReq('/api/admin/integrations/test', { tenantId: TENANT, id: 'vonage' }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.result).toBe('success');
    expect(JSON.stringify(json)).not.toContain('TEST-vonage-bundle');
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
