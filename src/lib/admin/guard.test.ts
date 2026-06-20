import { describe, expect, it } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import {
  asSiteId,
  asTenantId,
  type RoleAssignment,
  type TenantRole,
} from '@/domain/tenant/types';
import {
  AdminGuardError,
  assertCanRead,
  assertCanReadSite,
  assertCanWrite,
  assertCanWriteSite,
  forbidden,
  toGuardResponse,
  unauthorized,
} from './guard';

const T_A = asTenantId('tenant-a');
const T_B = asTenantId('tenant-b');
const S_1 = asSiteId('site-1');
const S_2 = asSiteId('site-2');

function assign(p: Partial<RoleAssignment> & { role: TenantRole }): RoleAssignment {
  return { tenantId: null, siteId: null, deviceId: null, ...p };
}
function actor(assignments: RoleAssignment[], status: Actor['status'] = 'active'): Actor {
  return { assignments, status };
}

const developer = actor([assign({ role: 'developer' })]);
const tenantAdmin = actor([assign({ role: 'tenant_admin', tenantId: T_A })]);
const siteManager = actor([assign({ role: 'site_manager', tenantId: T_A, siteId: S_1 })]);
const viewer = actor([assign({ role: 'viewer', tenantId: T_A })]);

function caught(fn: () => void): AdminGuardError | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof AdminGuardError ? e : null;
  }
}

describe('assertCanWrite (#91 最終認可・テナント境界)', () => {
  it('developer は任意テナントへ書ける', () => {
    expect(caught(() => assertCanWrite(developer, T_B))).toBeNull();
  });

  it('tenant_admin は自テナントのみ', () => {
    expect(caught(() => assertCanWrite(tenantAdmin, T_A))).toBeNull();
    const err = caught(() => assertCanWrite(tenantAdmin, T_B));
    expect(err?.status).toBe(403);
    expect(err?.code).toBe('forbidden');
  });

  it('viewer は書き込み不可（read は可）', () => {
    expect(caught(() => assertCanWrite(viewer, T_A))?.status).toBe(403);
    expect(caught(() => assertCanRead(viewer, T_A))).toBeNull();
  });
});

describe('assertCanWriteSite (#91 site_manager サイト境界)', () => {
  it('site_manager は割り当てサイトのみ書ける', () => {
    expect(caught(() => assertCanWriteSite(siteManager, T_A, S_1))).toBeNull();
    expect(caught(() => assertCanWriteSite(siteManager, T_A, S_2))?.status).toBe(403);
  });

  it('site_manager は他テナントへ書けない', () => {
    expect(caught(() => assertCanWriteSite(siteManager, T_B, S_1))?.status).toBe(403);
  });

  it('viewer はサイト read 可 / write 不可', () => {
    expect(caught(() => assertCanReadSite(viewer, T_A, S_1))).toBeNull();
    expect(caught(() => assertCanWriteSite(viewer, T_A, S_1))?.status).toBe(403);
  });
});

describe('toGuardResponse', () => {
  it('unauthorized → 401 { error: "unauthorized" }', async () => {
    const res = toGuardResponse(unauthorized());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('forbidden → 403 { error: "forbidden" }', async () => {
    const res = toGuardResponse(forbidden());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('AdminGuardError 以外は再 throw（バグを飲み込まない）', () => {
    const bug = new Error('boom');
    expect(() => toGuardResponse(bug)).toThrow(bug);
  });
});
