import { describe, expect, it } from 'vitest';
import {
  contextDenialStatus,
  resolveProductContext,
  type ProductContextInput,
} from './context';
import type { Actor } from '@/domain/tenant/authorization';
import {
  asDeviceId,
  asSiteId,
  asTenantId,
  type RoleAssignment,
  type TenantRole,
} from '@/domain/tenant/types';

const TENANT_A = asTenantId('tenant-a');
const TENANT_B = asTenantId('tenant-b');
const SITE_1 = asSiteId('site-1');
const SITE_2 = asSiteId('site-2');

function actorOf(assignments: RoleAssignment[], status: Actor['status'] = 'active'): Actor {
  return { assignments, status };
}

function assign(
  role: TenantRole,
  opts: { tenantId?: string; siteId?: string; deviceId?: string } = {},
): RoleAssignment {
  return {
    role,
    tenantId: opts.tenantId ? asTenantId(opts.tenantId) : null,
    siteId: opts.siteId ? asSiteId(opts.siteId) : null,
    deviceId: opts.deviceId ? asDeviceId(opts.deviceId) : null,
  };
}

const DEVELOPER = actorOf([assign('developer')]);
const TENANT_ADMIN_A = actorOf([assign('tenant_admin', { tenantId: 'tenant-a' })]);
const SITE_MANAGER_A1 = actorOf([
  assign('site_manager', { tenantId: 'tenant-a', siteId: 'site-1' }),
]);
const VIEWER_A = actorOf([assign('viewer', { tenantId: 'tenant-a' })]);
const KIOSK_DEVICE = actorOf([
  assign('kiosk_device', { tenantId: 'tenant-a', siteId: 'site-1', deviceId: 'kiosk-1' }),
]);

const DEVICE_BINDING = { tenantId: TENANT_A, siteId: SITE_1, kioskId: 'kiosk-1' };

function input(over: Partial<ProductContextInput>): ProductContextInput {
  return {
    actorId: 'actor-1',
    actor: TENANT_ADMIN_A,
    area: 'tenant',
    ...over,
  };
}

describe('resolveProductContext / kiosk-runtime（端末実行時）', () => {
  it('端末セッションの束縛を権威として採用し、クライアント指定の tenant/site/kiosk は信用しない', () => {
    const result = resolveProductContext(
      input({
        area: 'kiosk-runtime',
        actor: KIOSK_DEVICE,
        deviceBinding: DEVICE_BINDING,
        // 攻撃者が query で他テナントを指定したケース。
        requested: { tenantId: 'tenant-b', siteId: 'site-2', kioskId: 'kiosk-9' },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tenantId).toBe(TENANT_A);
    expect(result.value.siteId).toBe(SITE_1);
    expect(result.value.kioskId).toBe('kiosk-1');
    expect(result.value.role).toBe('kiosk_device');
    // 無視したことを可観測にする（監査・不正検知の手掛かり）。
    expect([...result.ignoredClientScope].sort()).toEqual(['kioskId', 'siteId', 'tenantId']);
  });

  it('クライアント指定が束縛と一致していれば無視リストは空', () => {
    const result = resolveProductContext(
      input({
        area: 'kiosk-runtime',
        actor: KIOSK_DEVICE,
        deviceBinding: DEVICE_BINDING,
        requested: { tenantId: 'tenant-a', siteId: 'site-1', kioskId: 'kiosk-1' },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ignoredClientScope).toEqual([]);
  });

  it('端末セッションが無ければ未認証（query だけでは構成を取得できない）', () => {
    const result = resolveProductContext(
      input({ area: 'kiosk-runtime', actor: null, requested: { kioskId: 'kiosk-1' } }),
    );

    expect(result).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it('セッションの束縛と actor の kiosk_device 割り当てが食い違えば拒否する', () => {
    const result = resolveProductContext(
      input({
        area: 'kiosk-runtime',
        actor: KIOSK_DEVICE,
        deviceBinding: { tenantId: TENANT_A, siteId: SITE_1, kioskId: 'kiosk-other' },
      }),
    );

    expect(result).toEqual({ ok: false, reason: 'cross_kiosk' });
  });

  it('管理ユーザーの資格で端末実行コンテキストは取得できない', () => {
    const result = resolveProductContext(
      input({ area: 'kiosk-runtime', actor: TENANT_ADMIN_A, deviceBinding: DEVICE_BINDING }),
    );

    expect(result).toEqual({ ok: false, reason: 'cross_kiosk' });
  });

  it('端末は draft 構成を要求できない（未公開の受付体験を配信しない）', () => {
    const result = resolveProductContext(
      input({
        area: 'kiosk-runtime',
        actor: KIOSK_DEVICE,
        deviceBinding: DEVICE_BINDING,
        version: { kind: 'draft' },
      }),
    );

    expect(result).toEqual({ ok: false, reason: 'draft_not_allowed' });
  });

  it('失効した端末 actor（suspended）は未認証扱い', () => {
    const revoked = actorOf(KIOSK_DEVICE.assignments, 'suspended');
    const result = resolveProductContext(
      input({ area: 'kiosk-runtime', actor: revoked, deviceBinding: DEVICE_BINDING }),
    );

    expect(result).toEqual({ ok: false, reason: 'unauthenticated' });
  });
});

describe('resolveProductContext / kiosk-preview（管理プレビュー）', () => {
  const preview = (actor: Actor, requested: Record<string, string>) =>
    resolveProductContext(input({ area: 'kiosk-preview', actor, requested }));

  it('自テナント・自サイトの端末はプレビューできる', () => {
    const result = preview(TENANT_ADMIN_A, {
      tenantId: 'tenant-a',
      siteId: 'site-1',
      kioskId: 'kiosk-1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      area: 'kiosk-preview',
      role: 'tenant_admin',
      tenantId: TENANT_A,
      siteId: SITE_1,
      kioskId: 'kiosk-1',
    });
  });

  it('別テナントの指定は cross_tenant（403）', () => {
    const result = preview(TENANT_ADMIN_A, {
      tenantId: 'tenant-b',
      siteId: 'site-1',
      kioskId: 'kiosk-1',
    });

    expect(result).toEqual({ ok: false, reason: 'cross_tenant' });
    expect(contextDenialStatus('cross_tenant')).toBe(403);
  });

  it('site_manager が担当外サイトを指定すれば cross_site（403）', () => {
    const result = preview(SITE_MANAGER_A1, {
      tenantId: 'tenant-a',
      siteId: 'site-2',
      kioskId: 'kiosk-9',
    });

    expect(result).toEqual({ ok: false, reason: 'cross_site' });
    expect(contextDenialStatus('cross_site')).toBe(403);
  });

  it('viewer は読み取りとしてプレビューできる（書き込み権限は別判定）', () => {
    const result = preview(VIEWER_A, {
      tenantId: 'tenant-a',
      siteId: 'site-1',
      kioskId: 'kiosk-1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.role).toBe('viewer');
  });

  it('developer は他テナントのプレビューも解決できる', () => {
    const result = preview(DEVELOPER, {
      tenantId: 'tenant-b',
      siteId: 'site-2',
      kioskId: 'kiosk-9',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ role: 'developer', tenantId: TENANT_B, siteId: SITE_2 });
  });

  it('kiosk/site/tenant のいずれかが欠けていれば scope_required（400）', () => {
    const result = preview(TENANT_ADMIN_A, { tenantId: 'tenant-a', siteId: 'site-1' });

    expect(result).toEqual({ ok: false, reason: 'scope_required' });
    expect(contextDenialStatus('scope_required')).toBe(400);
  });

  it('端末資格でプレビュー領域には入れない', () => {
    const result = resolveProductContext(
      input({
        area: 'kiosk-preview',
        actor: KIOSK_DEVICE,
        deviceBinding: DEVICE_BINDING,
        requested: { tenantId: 'tenant-a', siteId: 'site-1', kioskId: 'kiosk-1' },
      }),
    );

    expect(result).toEqual({ ok: false, reason: 'area_not_allowed' });
  });

  it('プレビューでは draft を指定でき、pinned は版 ID がコンテキストに載る', () => {
    const draft = resolveProductContext(
      input({
        area: 'kiosk-preview',
        actor: TENANT_ADMIN_A,
        requested: { tenantId: 'tenant-a', siteId: 'site-1', kioskId: 'kiosk-1' },
        version: { kind: 'draft' },
      }),
    );
    expect(draft.ok).toBe(true);

    const pinned = resolveProductContext(
      input({
        area: 'kiosk-preview',
        actor: TENANT_ADMIN_A,
        requested: { tenantId: 'tenant-a', siteId: 'site-1', kioskId: 'kiosk-1' },
        version: { kind: 'pinned', experienceVersionId: 'ver-7' },
      }),
    );
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) return;
    expect(pinned.value.experienceVersionId).toBe('ver-7');
  });
});

describe('resolveProductContext / tenant・platform 領域', () => {
  it('tenant 領域はサイト指定を省略できる', () => {
    const result = resolveProductContext(
      input({ area: 'tenant', actor: TENANT_ADMIN_A, requested: { tenantId: 'tenant-a' } }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tenantId).toBe(TENANT_A);
    expect(result.value.siteId).toBeUndefined();
  });

  it('tenant 領域でサイトを指定した場合は境界を検証する', () => {
    const result = resolveProductContext(
      input({
        area: 'tenant',
        actor: SITE_MANAGER_A1,
        requested: { tenantId: 'tenant-a', siteId: 'site-2' },
      }),
    );

    expect(result).toEqual({ ok: false, reason: 'cross_site' });
  });

  it('platform 領域は developer 以外を拒否する', () => {
    expect(resolveProductContext(input({ area: 'platform', actor: TENANT_ADMIN_A }))).toEqual({
      ok: false,
      reason: 'area_not_allowed',
    });

    const dev = resolveProductContext(input({ area: 'platform', actor: DEVELOPER }));
    expect(dev.ok).toBe(true);
    if (!dev.ok) return;
    expect(dev.value.role).toBe('developer');
    expect(dev.value.tenantId).toBeUndefined();
  });

  it('未認証・停止中の actor は unauthenticated（401）', () => {
    expect(resolveProductContext(input({ actor: null }))).toEqual({
      ok: false,
      reason: 'unauthenticated',
    });
    expect(
      resolveProductContext(
        input({ actor: actorOf(TENANT_ADMIN_A.assignments, 'suspended') }),
      ),
    ).toEqual({ ok: false, reason: 'unauthenticated' });
    expect(contextDenialStatus('unauthenticated')).toBe(401);
  });
});
