import { describe, expect, it } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import {
  asSiteId,
  asTenantId,
  type RoleAssignment,
  type TenantRole,
} from '@/domain/tenant/types';
import { type AdminArea, canEnterArea, isAreaAllowed } from './route-guard';

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
