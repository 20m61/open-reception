import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import type { AuditAction } from '@/domain/reception/log';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import { CallRouteService, type AppendAudit } from './call-route-service';
import { MemoryCallRouteRepository } from './repository';
import { asCallRouteId, type CallRoute } from './types';

const T_A = asTenantId('tenant-a');
const T_B = asTenantId('tenant-b');
const S_A1 = asSiteId('site-a1');
const S_A2 = asSiteId('site-a2');
const S_B1 = asSiteId('site-b1');

const developer: Actor = {
  status: 'active',
  assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }],
};
const tenantAdminA: Actor = {
  status: 'active',
  assignments: [{ role: 'tenant_admin', tenantId: T_A, siteId: null, deviceId: null }],
};
const siteManagerA1: Actor = {
  status: 'active',
  assignments: [{ role: 'site_manager', tenantId: T_A, siteId: S_A1, deviceId: null }],
};
const viewerA: Actor = {
  status: 'active',
  assignments: [{ role: 'viewer', tenantId: T_A, siteId: null, deviceId: null }],
};

function route(over: Partial<CallRoute> & Pick<CallRoute, 'id' | 'tenantId' | 'siteId'>): CallRoute {
  return {
    name: 'ルート',
    groups: [],
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function makeService(seed: CallRoute[] = []) {
  const audits: Array<{ action: AuditAction; metadata?: Record<string, string> }> = [];
  const appendAudit: AppendAudit = vi.fn(async (action, _t, metadata) => {
    audits.push({ action, metadata });
  });
  const repo = new MemoryCallRouteRepository(seed);
  const svc = new CallRouteService({
    routes: repo,
    appendAudit,
    now: () => new Date('2026-06-20T00:00:00.000Z'),
  });
  return { svc, audits, repo };
}

const SEED = [
  route({ id: asCallRouteId('r-a1'), tenantId: T_A, siteId: S_A1, name: '本社ルート' }),
  route({ id: asCallRouteId('r-a2'), tenantId: T_A, siteId: S_A2, name: '支店ルート' }),
  route({ id: asCallRouteId('r-b1'), tenantId: T_B, siteId: S_B1, name: '他社ルート' }),
];

describe('CallRouteService.list (#88)', () => {
  it('テナント配下のルートを返す', async () => {
    const { svc } = makeService(SEED);
    const r = await svc.list(tenantAdminA, T_A);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((x) => x.id).sort()).toEqual(['r-a1', 'r-a2']);
  });

  it('site_manager は担当サイトのルートのみ見える', async () => {
    const { svc } = makeService(SEED);
    const r = await svc.list(siteManagerA1, T_A);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((x) => x.id)).toEqual(['r-a1']);
  });

  it('他テナントのルートは越境取得できない', async () => {
    const { svc } = makeService(SEED);
    const r = await svc.list(tenantAdminA, T_B);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  it('siteId 指定で絞り込める', async () => {
    const { svc } = makeService(SEED);
    const r = await svc.list(developer, T_A, S_A2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((x) => x.id)).toEqual(['r-a2']);
  });
});

describe('CallRouteService.get (#88)', () => {
  it('テナント越境の取得は forbidden（id を知っていても拒否）', async () => {
    const { svc } = makeService(SEED);
    const r = await svc.get(tenantAdminA, T_A, asCallRouteId('r-b1'));
    // tenantId=T_A では r-b1 が見つからないため not_found を返す（境界で隔離）。
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_found');
  });
});

describe('CallRouteService.create (#88)', () => {
  it('tenant_admin は作成でき、監査に created を残す（PII なし）', async () => {
    const { svc, audits } = makeService();
    const r = await svc.create(tenantAdminA, {
      tenantId: T_A,
      siteId: S_A1,
      name: '新ルート',
      groups: [
        { label: '総務', targets: [{ label: '代表', channel: 'phone', value: '+81300000000', priority: 0 }] },
      ],
    });
    expect(r.ok).toBe(true);
    expect(audits.map((a) => a.action)).toContain('call_route.created');
    const meta = audits[0]?.metadata ?? {};
    // 機微値（電話番号）は監査に残さない。件数のみ。
    expect(JSON.stringify(meta)).not.toContain('+81300000000');
    expect(meta.targetCount).toBe('1');
  });

  it('viewer は作成できない（書込不可）', async () => {
    const { svc } = makeService();
    const r = await svc.create(viewerA, { tenantId: T_A, siteId: S_A1, name: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('他テナントへの作成は拒否（越境書込）', async () => {
    const { svc } = makeService();
    const r = await svc.create(tenantAdminA, { tenantId: T_B, siteId: S_B1, name: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('site_manager は担当外サイトに作成できない', async () => {
    const { svc } = makeService();
    const r = await svc.create(siteManagerA1, { tenantId: T_A, siteId: S_A2, name: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('空のルート名は invalid_input', async () => {
    const { svc } = makeService();
    const r = await svc.create(tenantAdminA, { tenantId: T_A, siteId: S_A1, name: '  ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_input');
  });

  it('不正なチャネルは invalid_input', async () => {
    const { svc } = makeService();
    const r = await svc.create(tenantAdminA, {
      tenantId: T_A,
      siteId: S_A1,
      name: 'x',
      // @ts-expect-error 意図的に不正なチャネル
      groups: [{ label: 'g', targets: [{ label: 't', channel: 'fax', value: '1', priority: 0 }] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_input');
  });
});

describe('CallRouteService.update (#88)', () => {
  it('tenant_admin は有効/無効を切り替えられ、監査に updated を残す', async () => {
    const { svc, audits } = makeService(SEED);
    const r = await svc.update(tenantAdminA, T_A, asCallRouteId('r-a1'), { enabled: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.enabled).toBe(false);
    expect(audits.map((a) => a.action)).toContain('call_route.updated');
  });

  it('viewer は更新できない', async () => {
    const { svc } = makeService(SEED);
    const r = await svc.update(viewerA, T_A, asCallRouteId('r-a1'), { enabled: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('他テナントのルートは更新できない（越境）', async () => {
    const { svc } = makeService(SEED);
    const r = await svc.update(tenantAdminA, T_A, asCallRouteId('r-b1'), { name: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_found');
  });

  it('site_manager は担当外サイトのルートを更新できない', async () => {
    const { svc } = makeService(SEED);
    const r = await svc.update(siteManagerA1, T_A, asCallRouteId('r-a2'), { name: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });
});

describe('CallRouteService.remove (#88)', () => {
  it('tenant_admin は削除でき、監査に deleted を残す', async () => {
    const { svc, audits, repo } = makeService(SEED);
    const r = await svc.remove(tenantAdminA, T_A, asCallRouteId('r-a1'));
    expect(r.ok).toBe(true);
    expect(await repo.getRoute(T_A, asCallRouteId('r-a1'))).toBeUndefined();
    expect(audits.map((a) => a.action)).toContain('call_route.deleted');
  });

  it('viewer は削除できない', async () => {
    const { svc } = makeService(SEED);
    const r = await svc.remove(viewerA, T_A, asCallRouteId('r-a1'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('他テナントのルートは削除できない（越境）', async () => {
    const { svc } = makeService(SEED);
    const r = await svc.remove(tenantAdminA, T_A, asCallRouteId('r-b1'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_found');
  });
});
