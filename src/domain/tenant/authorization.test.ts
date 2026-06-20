import { describe, expect, it } from 'vitest';
import {
  accessibleTenants,
  canAccessSite,
  canAccessTenant,
  canDeviceAct,
  canRoleWrite,
  type Actor,
} from './authorization';
import {
  asDeviceId,
  asSiteId,
  asTenantId,
  type RoleAssignment,
  type TenantRole,
} from './types';

const T_A = asTenantId('tenant-a');
const T_B = asTenantId('tenant-b');
const S_1 = asSiteId('site-1');
const S_2 = asSiteId('site-2');
const D_1 = asDeviceId('device-1');
const D_2 = asDeviceId('device-2');

function assign(partial: Partial<RoleAssignment> & { role: TenantRole }): RoleAssignment {
  return { tenantId: null, siteId: null, deviceId: null, ...partial };
}

function actor(assignments: RoleAssignment[], status: Actor['status'] = 'active'): Actor {
  return { assignments, status };
}

describe('canRoleWrite (#80)', () => {
  it.each<[TenantRole, boolean]>([
    ['developer', true],
    ['tenant_admin', true],
    ['site_manager', true],
    ['viewer', false],
    ['kiosk_device', false],
  ])('%s -> write=%s', (role, expected) => {
    expect(canRoleWrite(role)).toBe(expected);
  });
});

describe('canAccessTenant (#80)', () => {
  const cases: Array<{
    name: string;
    a: RoleAssignment[];
    tenant: typeof T_A;
    op: 'read' | 'write';
    expected: boolean;
  }> = [
    {
      name: 'developer は他テナントも read 可',
      a: [assign({ role: 'developer' })],
      tenant: T_B,
      op: 'read',
      expected: true,
    },
    {
      name: 'developer は write 可',
      a: [assign({ role: 'developer' })],
      tenant: T_B,
      op: 'write',
      expected: true,
    },
    {
      name: 'tenant_admin は自テナント read/write 可',
      a: [assign({ role: 'tenant_admin', tenantId: T_A })],
      tenant: T_A,
      op: 'write',
      expected: true,
    },
    {
      name: 'tenant_admin は他テナント不可',
      a: [assign({ role: 'tenant_admin', tenantId: T_A })],
      tenant: T_B,
      op: 'read',
      expected: false,
    },
    {
      name: 'viewer は read 可・write 不可',
      a: [assign({ role: 'viewer', tenantId: T_A })],
      tenant: T_A,
      op: 'write',
      expected: false,
    },
    {
      name: 'viewer は read 可',
      a: [assign({ role: 'viewer', tenantId: T_A })],
      tenant: T_A,
      op: 'read',
      expected: true,
    },
    {
      name: '割り当て無しは不可',
      a: [],
      tenant: T_A,
      op: 'read',
      expected: false,
    },
  ];
  it.each(cases)('$name', ({ a, tenant, op, expected }) => {
    expect(canAccessTenant(actor(a), tenant, op)).toBe(expected);
  });

  it('suspended ユーザーは全て不可', () => {
    expect(
      canAccessTenant(actor([assign({ role: 'tenant_admin', tenantId: T_A })], 'suspended'), T_A),
    ).toBe(false);
  });
});

describe('canAccessSite (#80)', () => {
  it('tenant_admin は自テナントの全サイトへ', () => {
    const a = actor([assign({ role: 'tenant_admin', tenantId: T_A })]);
    expect(canAccessSite(a, T_A, S_1)).toBe(true);
    expect(canAccessSite(a, T_A, S_2)).toBe(true);
    expect(canAccessSite(a, T_B, S_1)).toBe(false);
  });

  it('site_manager は割り当てサイトのみ', () => {
    const a = actor([assign({ role: 'site_manager', tenantId: T_A, siteId: S_1 })]);
    expect(canAccessSite(a, T_A, S_1, 'write')).toBe(true);
    expect(canAccessSite(a, T_A, S_2, 'write')).toBe(false);
    expect(canAccessSite(a, T_B, S_1)).toBe(false);
  });

  it('viewer(サイト指定なし)はテナント配下サイトを read 可・write 不可', () => {
    const a = actor([assign({ role: 'viewer', tenantId: T_A })]);
    expect(canAccessSite(a, T_A, S_1, 'read')).toBe(true);
    expect(canAccessSite(a, T_A, S_1, 'write')).toBe(false);
  });

  it('viewer(サイト指定)は当該サイトのみ', () => {
    const a = actor([assign({ role: 'viewer', tenantId: T_A, siteId: S_1 })]);
    expect(canAccessSite(a, T_A, S_1)).toBe(true);
    expect(canAccessSite(a, T_A, S_2)).toBe(false);
  });

  it('developer は全サイト可', () => {
    const a = actor([assign({ role: 'developer' })]);
    expect(canAccessSite(a, T_B, S_2, 'write')).toBe(true);
  });
});

describe('canDeviceAct (#80)', () => {
  const a = actor([
    assign({ role: 'kiosk_device', tenantId: T_A, siteId: S_1, deviceId: D_1 }),
  ]);
  it('束縛が完全一致すれば可', () => {
    expect(canDeviceAct(a, T_A, S_1, D_1)).toBe(true);
  });
  it('tenant/site/device のいずれかがずれると不可', () => {
    expect(canDeviceAct(a, T_B, S_1, D_1)).toBe(false);
    expect(canDeviceAct(a, T_A, S_2, D_1)).toBe(false);
    expect(canDeviceAct(a, T_A, S_1, D_2)).toBe(false);
  });
  it('管理ロールでは端末操作不可（端末ロール専用）', () => {
    const admin = actor([assign({ role: 'tenant_admin', tenantId: T_A })]);
    expect(canDeviceAct(admin, T_A, S_1, D_1)).toBe(false);
    const dev = actor([assign({ role: 'developer' })]);
    expect(canDeviceAct(dev, T_A, S_1, D_1)).toBe(false);
  });
});

describe('accessibleTenants (#80)', () => {
  it('developer は all スコープ', () => {
    expect(accessibleTenants(actor([assign({ role: 'developer' })]))).toEqual({ scope: 'all' });
  });
  it('複数所属はテナント ID 集合を返す（重複排除）', () => {
    const a = actor([
      assign({ role: 'tenant_admin', tenantId: T_A }),
      assign({ role: 'viewer', tenantId: T_B }),
      assign({ role: 'site_manager', tenantId: T_A, siteId: S_1 }),
    ]);
    const result = accessibleTenants(a);
    expect(result.scope).toBe('tenants');
    if (result.scope === 'tenants') {
      expect([...result.tenantIds].sort()).toEqual([T_A, T_B].sort());
    }
  });
  it('suspended は空', () => {
    const a = actor([assign({ role: 'tenant_admin', tenantId: T_A })], 'suspended');
    expect(accessibleTenants(a)).toEqual({ scope: 'tenants', tenantIds: [] });
  });
});
