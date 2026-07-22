/**
 * provider 設定を管理できるかの認可判定（純関数）テスト (issue #405 Inc1)。
 *
 * 認可は authorizePlatform に一点集約しつつ、将来 tenant_admin 開放を想定して判定関数を切り出す。
 * Inc1 では developer（全テナント横断）のみ許可し、tenant_admin/viewer は全テナントで不可（越境不可）。
 */
import { describe, expect, it } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { asTenantId } from '@/domain/tenant/types';
import { canManageTenantProviderConfig } from './provider-config-access';

function developer(): Actor {
  return { status: 'active', assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }] };
}
function tenantAdmin(tenant: string): Actor {
  return {
    status: 'active',
    assignments: [{ role: 'tenant_admin', tenantId: asTenantId(tenant), siteId: null, deviceId: null }],
  };
}
function viewer(tenant: string): Actor {
  return {
    status: 'active',
    assignments: [{ role: 'viewer', tenantId: asTenantId(tenant), siteId: null, deviceId: null }],
  };
}

describe('canManageTenantProviderConfig (#405 Inc1)', () => {
  it('developer は任意テナントの設定を管理できる', () => {
    expect(canManageTenantProviderConfig(developer(), asTenantId('internal'))).toBe(true);
    expect(canManageTenantProviderConfig(developer(), asTenantId('acme'))).toBe(true);
  });

  it('tenant_admin は自テナント含め不可（Inc1 は developer 限定・越境不可）', () => {
    expect(canManageTenantProviderConfig(tenantAdmin('internal'), asTenantId('internal'))).toBe(false);
    expect(canManageTenantProviderConfig(tenantAdmin('internal'), asTenantId('acme'))).toBe(false);
  });

  it('viewer は不可', () => {
    expect(canManageTenantProviderConfig(viewer('internal'), asTenantId('internal'))).toBe(false);
  });

  it('非 active は不可', () => {
    const suspended: Actor = { status: 'suspended', assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }] };
    expect(canManageTenantProviderConfig(suspended, asTenantId('internal'))).toBe(false);
  });
});
