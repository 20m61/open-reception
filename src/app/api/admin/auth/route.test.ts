/**
 * 認証方式設定 API（/api/admin/auth）の単体テスト (issue #70)。
 * 認可境界（未認証 401 / viewer 403 / tenant_admin 200）と機密値の非露出を検証する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { asTenantId } from '@/domain/tenant/types';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
}));

import { GET } from './route';

const ENV_KEYS = [
  'ADMIN_AUTH_PROVIDER',
  'ENTRA_TENANT_ID',
  'ENTRA_CLIENT_ID',
  'ENTRA_AUDIENCE',
  'ADMIN_ALLOWED_ROLES',
];
const saved: Record<string, string | undefined> = {};

function tenantAdmin(): Actor {
  return {
    status: 'active',
    assignments: [{ role: 'tenant_admin', tenantId: asTenantId('internal'), siteId: null, deviceId: null }],
  };
}
function viewer(): Actor {
  return {
    status: 'active',
    assignments: [{ role: 'viewer', tenantId: asTenantId('internal'), siteId: null, deviceId: null }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('GET /api/admin/auth (#70)', () => {
  it('401 when no admin session', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it('403 for viewer (read-only cannot manage auth config)', async () => {
    resolveAdminActor.mockResolvedValue(viewer());
    expect((await GET()).status).toBe(403);
  });

  it('tenant_admin can read provider status (200)', async () => {
    resolveAdminActor.mockResolvedValue(tenantAdmin());
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.provider).toBe('none');
  });

  it('returns entra setting presence without leaking secret values', async () => {
    process.env.ADMIN_AUTH_PROVIDER = 'entra';
    process.env.ENTRA_TENANT_ID = 'secret-tenant-xyz';
    process.env.ENTRA_CLIENT_ID = 'secret-client-abc';
    resolveAdminActor.mockResolvedValue(tenantAdmin());
    const res = await GET();
    const text = await res.text();
    expect(text).not.toContain('secret-tenant-xyz');
    expect(text).not.toContain('secret-client-abc');
    const json = JSON.parse(text);
    expect(json.provider).toBe('entra');
    const clientId = json.entra.settings.find((s: { key: string }) => s.key === 'clientId');
    expect(clientId.presence).toBe('set');
  });
});
