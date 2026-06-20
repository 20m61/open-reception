import { describe, expect, it } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { asSiteId, asTenantId, type Tenant } from '@/domain/tenant/types';
import {
  canSelectTenant,
  isSwitchable,
  resolveActiveTenantId,
  selectableTenants,
} from './tenant-selection';

const T_A = asTenantId('tenant-a');
const T_B = asTenantId('tenant-b');
const T_C = asTenantId('tenant-c');
const S_A1 = asSiteId('site-a1');

const now = '2026-06-20T00:00:00.000Z';
function tenant(id: ReturnType<typeof asTenantId>, slug: string): Tenant {
  return { id, name: `Tenant ${slug}`, slug, status: 'active', createdAt: now, updatedAt: now };
}
const ALL = [tenant(T_A, 'a'), tenant(T_B, 'b'), tenant(T_C, 'c')];

const developer: Actor = {
  status: 'active',
  assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }],
};
const tenantAdminA: Actor = {
  status: 'active',
  assignments: [{ role: 'tenant_admin', tenantId: T_A, siteId: null, deviceId: null }],
};
const multiAB: Actor = {
  status: 'active',
  assignments: [
    { role: 'tenant_admin', tenantId: T_A, siteId: null, deviceId: null },
    { role: 'viewer', tenantId: T_B, siteId: null, deviceId: null },
  ],
};
const siteManagerA1: Actor = {
  status: 'active',
  assignments: [{ role: 'site_manager', tenantId: T_A, siteId: S_A1, deviceId: null }],
};
const suspended: Actor = {
  status: 'suspended',
  assignments: [{ role: 'tenant_admin', tenantId: T_A, siteId: null, deviceId: null }],
};

describe('selectableTenants (#80 inc3 選択可能テナント導出)', () => {
  it('developer は全テナント', () => {
    expect(selectableTenants(developer, ALL).map((o) => o.id)).toEqual([T_A, T_B, T_C]);
  });

  it('単一所属は所属テナントのみ', () => {
    expect(selectableTenants(tenantAdminA, ALL).map((o) => o.id)).toEqual([T_A]);
  });

  it('複数所属は所属テナントのみ（入力順を保つ）', () => {
    expect(selectableTenants(multiAB, ALL).map((o) => o.id)).toEqual([T_A, T_B]);
  });

  it('site_manager も所属テナント単位で選べる', () => {
    expect(selectableTenants(siteManagerA1, ALL).map((o) => o.id)).toEqual([T_A]);
  });

  it('suspended actor は空', () => {
    expect(selectableTenants(suspended, ALL)).toHaveLength(0);
  });

  it('option は id/name/slug のみ（機密・PII を含めない）', () => {
    const o = selectableTenants(tenantAdminA, ALL)[0];
    expect(o && Object.keys(o).sort()).toEqual(['id', 'name', 'slug']);
  });
});

describe('canSelectTenant (#80 inc3 越境拒否)', () => {
  it('developer は任意テナントを選べる', () => {
    expect(canSelectTenant(developer, T_C)).toBe(true);
  });
  it('所属テナントは選べる', () => {
    expect(canSelectTenant(tenantAdminA, T_A)).toBe(true);
  });
  it('非所属テナント（越境）は拒否', () => {
    expect(canSelectTenant(tenantAdminA, T_B)).toBe(false);
  });
  it('suspended actor はどのテナントも選べない', () => {
    expect(canSelectTenant(suspended, T_A)).toBe(false);
  });
});

describe('resolveActiveTenantId (#80 inc3 越境を安全側へ倒す)', () => {
  it('有効な選択を採用する', () => {
    expect(resolveActiveTenantId(multiAB, ALL, T_B)).toBe(T_B);
  });
  it('越境 cookie は採用せず選択肢の先頭へフォールバック', () => {
    expect(resolveActiveTenantId(tenantAdminA, ALL, T_B)).toBe(T_A);
  });
  it('未選択（cookie 無し）は先頭', () => {
    expect(resolveActiveTenantId(multiAB, ALL, null)).toBe(T_A);
  });
  it('失効した選択（存在しない id）は先頭へフォールバック', () => {
    expect(resolveActiveTenantId(developer, ALL, 'tenant-x')).toBe(T_A);
  });
  it('未所属 actor は undefined', () => {
    expect(resolveActiveTenantId(suspended, ALL, T_A)).toBeUndefined();
  });
});

describe('isSwitchable (#80 inc3 固定表示/切替判定)', () => {
  it('単一所属は固定表示', () => {
    expect(isSwitchable(selectableTenants(tenantAdminA, ALL))).toBe(false);
  });
  it('複数所属は切替可能', () => {
    expect(isSwitchable(selectableTenants(multiAB, ALL))).toBe(true);
  });
  it('developer（複数テナント）は切替可能', () => {
    expect(isSwitchable(selectableTenants(developer, ALL))).toBe(true);
  });
});
