/**
 * プラットフォーム運用コンソール API（increment 3）の認可境界・payload テスト (issue #90 / #83)。
 *
 * 追加 read API（外部連携状態 /api/platform/integrations）が developer 専用であること
 * （未認証 401 / 非 developer 403 / developer 200）と、返却に機密値を含めない
 * （登録状態・接続結果・最終日時のみ／whitelist 済み）ことを検証する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { asTenantId } from '@/domain/tenant/types';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const listIntegrationStatuses = vi.fn<() => Promise<unknown[]>>();
const listAuthMethodStatuses = vi.fn();

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
}));
vi.mock('@/lib/security/integration-status-store', () => ({
  listIntegrationStatuses: () => listIntegrationStatuses(),
  listAuthMethodStatuses: () => listAuthMethodStatuses(),
}));

import { GET as INTEGRATIONS } from './integrations/route';

function developer(): Actor {
  return {
    status: 'active',
    assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }],
  };
}
function tenantAdmin(): Actor {
  return {
    status: 'active',
    assignments: [
      { role: 'tenant_admin', tenantId: asTenantId('internal'), siteId: null, deviceId: null },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listIntegrationStatuses.mockResolvedValue([
    {
      id: 'vonage',
      label: 'Vonage',
      configured: true,
      enabled: false,
      lastResult: 'failure',
      lastFailureAt: '2026-06-01T00:00:00.000Z',
      lastErrorSummary: 'auth failed',
      // 機密が将来混入しても漏れないことを射影の whitelist が担保する（テストで確認）。
      apiSecret: 'SHOULD-NOT-LEAK',
    },
  ]);
  listAuthMethodStatuses.mockReturnValue([
    { id: 'entra', label: 'Entra ID', enabled: true, issues: [] },
    { id: 'password', label: '共有パスワード', enabled: false, issues: ['未設定'] },
  ]);
});

describe('GET /api/platform/integrations authorization', () => {
  it('401 when unauthenticated', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await INTEGRATIONS()).status).toBe(401);
  });
  it('403 for non-developer', async () => {
    resolveAdminActor.mockResolvedValue(tenantAdmin());
    expect((await INTEGRATIONS()).status).toBe(403);
  });
  it('200 for developer', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    expect((await INTEGRATIONS()).status).toBe(200);
  });
});

describe('GET /api/platform/integrations payload safety', () => {
  beforeEach(() => resolveAdminActor.mockResolvedValue(developer()));

  it('returns integrations + authMethods without secrets', async () => {
    const body = await (await INTEGRATIONS()).json();
    expect(body.integrations).toHaveLength(1);
    const row = body.integrations[0];
    expect(row).toMatchObject({ id: 'vonage', label: 'Vonage', configured: true, enabled: false });
    expect(row.lastResult).toBe('failure');
    // whitelist 射影なので想定外フィールド（機密含む）は載らない。
    expect('apiSecret' in row).toBe(false);
    expect(JSON.stringify(body)).not.toContain('SHOULD-NOT-LEAK');
  });

  it('returns auth methods sorted by label with issues', async () => {
    const body = await (await INTEGRATIONS()).json();
    expect(body.authMethods.map((m: { id: string }) => m.id)).toEqual(['entra', 'password']);
    expect(body.authMethods[1].issues).toEqual(['未設定']);
  });
});
