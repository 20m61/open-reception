import { describe, expect, it } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import {
  asSiteId,
  asTenantId,
  type RoleAssignment,
  type TenantRole,
} from '@/domain/tenant/types';
import {
  type AdminArea,
  type AdminScreenKey,
  canActOnSite,
  canActOnTenant,
  canEnterArea,
  canEnterScreen,
  canWriteAnywhere,
  isAreaAllowed,
  isScreenAllowed,
} from './route-guard';

const T_A = asTenantId('tenant-a');
const S_1 = asSiteId('site-1');

function assign(partial: Partial<RoleAssignment> & { role: TenantRole }): RoleAssignment {
  return { tenantId: null, siteId: null, deviceId: null, ...partial };
}

function actor(assignments: RoleAssignment[], status: Actor['status'] = 'active'): Actor {
  return { assignments, status };
}

describe('canEnterArea (#85, #80)', () => {
  const developer = actor([assign({ role: 'developer' })]);
  const tenantAdmin = actor([assign({ role: 'tenant_admin', tenantId: T_A })]);
  const siteManager = actor([assign({ role: 'site_manager', tenantId: T_A, siteId: S_1 })]);
  const viewer = actor([assign({ role: 'viewer', tenantId: T_A })]);

  const cases: Array<{ name: string; a: Actor | null; area: AdminArea; allowed: boolean }> = [
    { name: 'developer → admin', a: developer, area: 'admin', allowed: true },
    { name: 'developer → platform', a: developer, area: 'platform', allowed: true },
    { name: 'tenant_admin → admin', a: tenantAdmin, area: 'admin', allowed: true },
    { name: 'tenant_admin → platform 不可', a: tenantAdmin, area: 'platform', allowed: false },
    { name: 'site_manager → admin', a: siteManager, area: 'admin', allowed: true },
    { name: 'site_manager → platform 不可', a: siteManager, area: 'platform', allowed: false },
    { name: 'viewer → admin', a: viewer, area: 'admin', allowed: true },
    { name: 'viewer → platform 不可', a: viewer, area: 'platform', allowed: false },
    { name: 'null → admin 不可', a: null, area: 'admin', allowed: false },
    { name: 'null → platform 不可', a: null, area: 'platform', allowed: false },
  ];

  it.each(cases)('$name', ({ a, area, allowed }) => {
    expect(canEnterArea(a, area).allowed).toBe(allowed);
    expect(isAreaAllowed(a, area)).toBe(allowed);
  });

  it('未認証は reason=unauthenticated', () => {
    const r = canEnterArea(null, 'admin');
    expect(r).toEqual({ allowed: false, reason: 'unauthenticated' });
  });

  it('非 active な actor は unauthenticated 扱い', () => {
    const suspended = actor([assign({ role: 'developer' })], 'suspended');
    expect(canEnterArea(suspended, 'admin')).toEqual({
      allowed: false,
      reason: 'unauthenticated',
    });
  });

  it('割り当て無しは unauthenticated 扱い', () => {
    expect(canEnterArea(actor([]), 'admin')).toEqual({
      allowed: false,
      reason: 'unauthenticated',
    });
  });

  it('テナントロールの platform 拒否は forbidden-area', () => {
    expect(canEnterArea(tenantAdmin, 'platform')).toEqual({
      allowed: false,
      reason: 'forbidden-area',
    });
  });
});

describe('canEnterScreen / canWriteAnywhere (#91 per-screen ガード)', () => {
  const developer = actor([assign({ role: 'developer' })]);
  const tenantAdmin = actor([assign({ role: 'tenant_admin', tenantId: T_A })]);
  const viewer = actor([assign({ role: 'viewer', tenantId: T_A })]);

  it('canWriteAnywhere: 書き込みロールのみ true', () => {
    expect(canWriteAnywhere(developer)).toBe(true);
    expect(canWriteAnywhere(tenantAdmin)).toBe(true);
    expect(canWriteAnywhere(viewer)).toBe(false);
    expect(canWriteAnywhere(null)).toBe(false);
    expect(canWriteAnywhere(actor([assign({ role: 'developer' })], 'suspended'))).toBe(false);
  });

  const screenCases: Array<{
    name: string;
    a: Actor | null;
    screen: AdminScreenKey;
    allowed: boolean;
  }> = [
    { name: 'viewer → admin:audit (read) 可', a: viewer, screen: 'admin:audit', allowed: true },
    { name: 'viewer → admin:dashboard (read) 可', a: viewer, screen: 'admin:dashboard', allowed: true },
    { name: 'viewer → admin:security (write) 不可', a: viewer, screen: 'admin:security', allowed: false },
    { name: 'tenant_admin → admin:security 可', a: tenantAdmin, screen: 'admin:security', allowed: true },
    { name: 'developer → admin:security 可', a: developer, screen: 'admin:security', allowed: true },
    { name: 'null → admin:audit 不可', a: null, screen: 'admin:audit', allowed: false },
  ];

  it.each(screenCases)('$name', ({ a, screen, allowed }) => {
    expect(canEnterScreen(a, screen).allowed).toBe(allowed);
    expect(isScreenAllowed(a, screen)).toBe(allowed);
  });

  it('viewer の write 画面拒否理由は forbidden-write', () => {
    expect(canEnterScreen(viewer, 'admin:security')).toEqual({
      allowed: false,
      reason: 'forbidden-write',
    });
  });

  it('未認証は unauthenticated', () => {
    expect(canEnterScreen(null, 'admin:security')).toEqual({
      allowed: false,
      reason: 'unauthenticated',
    });
  });
});

describe('canActOnTenant / canActOnSite (#91 操作導線判定)', () => {
  const developer = actor([assign({ role: 'developer' })]);
  const tenantAdmin = actor([assign({ role: 'tenant_admin', tenantId: T_A })]);
  const siteManager = actor([assign({ role: 'site_manager', tenantId: T_A, siteId: S_1 })]);
  const viewer = actor([assign({ role: 'viewer', tenantId: T_A })]);
  const S_2 = asSiteId('site-2');
  const T_B = asTenantId('tenant-b');

  it('canActOnTenant: write/read 境界', () => {
    expect(canActOnTenant(tenantAdmin, T_A, 'write')).toBe(true);
    expect(canActOnTenant(tenantAdmin, T_B, 'write')).toBe(false);
    expect(canActOnTenant(viewer, T_A, 'write')).toBe(false);
    expect(canActOnTenant(viewer, T_A, 'read')).toBe(true);
    expect(canActOnTenant(developer, T_B, 'write')).toBe(true);
    expect(canActOnTenant(null, T_A, 'read')).toBe(false);
  });

  it('canActOnSite: site_manager のサイト境界', () => {
    expect(canActOnSite(siteManager, T_A, S_1, 'write')).toBe(true);
    expect(canActOnSite(siteManager, T_A, S_2, 'write')).toBe(false);
    expect(canActOnSite(viewer, T_A, S_1, 'write')).toBe(false);
    expect(canActOnSite(viewer, T_A, S_1, 'read')).toBe(true);
    expect(canActOnSite(null, T_A, S_1, 'read')).toBe(false);
  });
});
