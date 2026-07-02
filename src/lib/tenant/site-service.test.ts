import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import type { AuditAction } from '@/domain/reception/log';
import {
  asDeviceId,
  asSiteId,
  asTenantId,
  type Device,
  type Site,
} from '@/domain/tenant/types';
import { __resetBackend } from '@/lib/data';
import { DataBackedTenantStore } from './data-repository';
import { SiteService, type AppendAudit } from './site-service';

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

function site(over: Partial<Site> & Pick<Site, 'id' | 'tenantId'>): Site {
  return {
    name: 'サイト',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}
const NOW = new Date('2026-06-20T00:00:00.000Z');

function device(
  id: string,
  tenantId = T_A,
  siteId = S_A1,
  status: Device['status'] = 'active',
  lastSeenAt?: string,
): Device {
  return {
    id: asDeviceId(id),
    tenantId,
    siteId,
    name: id,
    status,
    lastSeenAt,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeService() {
  const audits: Array<{ action: AuditAction; metadata?: Record<string, string> }> = [];
  const appendAudit: AppendAudit = vi.fn(async (action, _t, metadata) => {
    audits.push({ action, metadata });
  });
  // §9 標準（#274）: エンティティ専用の in-memory repository は持たない。
  // memory backend + seed で DataBacked 実装をそのままテストする（テスト毎に backend を作り直す）。
  __resetBackend();
  const store = new DataBackedTenantStore({
    sites: [
      site({ id: S_A1, tenantId: T_A, name: '本社受付' }),
      site({ id: S_A2, tenantId: T_A, name: '名古屋支店' }),
      site({ id: S_B1, tenantId: T_B, name: '他社受付' }),
    ],
    devices: [
      // dev-1 は直近の heartbeat ありで online。dev-2 は revoked、dev-4 は heartbeat 未着で offline。
      device('dev-1', T_A, S_A1, 'active', NOW.toISOString()),
      device('dev-2', T_A, S_A1, 'revoked'),
      device('dev-4', T_A, S_A1, 'active'),
      device('dev-3', T_B, S_B1, 'active'),
    ],
  });
  const svc = new SiteService({
    sites: store.sites,
    devices: store.devices,
    appendAudit,
    now: () => NOW,
  });
  return { svc, audits, store };
}

describe('SiteService.list (#87)', () => {
  it('テナント配下の拠点を端末集計つきで返す', async () => {
    const { svc } = makeService();
    const r = await svc.list(tenantAdminA, T_A);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.map((s) => s.id).sort()).toEqual([S_A1, S_A2].sort());
      const a1 = r.value.find((s) => s.id === S_A1);
      expect(a1?.deviceCount).toBe(3);
      // inc3: online は実 heartbeat（lastSeenAt が窓内）由来。dev-1 のみ。
      // revoked（dev-2）・heartbeat 未着（dev-4）は online に数えない。
      expect(a1?.onlineDeviceCount).toBe(1);
    }
  });

  it('他テナントの拠点は返さない（テナント越境拒否）', async () => {
    const { svc } = makeService();
    const r = await svc.list(tenantAdminA, T_A);
    if (r.ok) expect(r.value.map((s) => s.id)).not.toContain(S_B1);
  });

  it('site_manager は権限のあるサイトのみ見える', async () => {
    const { svc } = makeService();
    const r = await svc.list(siteManagerA1, T_A);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((s) => s.id)).toEqual([S_A1]);
  });

  it('テナント割り当てのない actor は forbidden', async () => {
    const { svc } = makeService();
    const r = await svc.list(tenantAdminA, T_B);
    expect(r).toEqual({ ok: false, error: { code: 'forbidden', message: expect.any(String) } });
  });

  it('developer は全テナント横断で閲覧できる', async () => {
    const { svc } = makeService();
    const r = await svc.list(developer, T_B);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((s) => s.id)).toEqual([S_B1]);
  });
});

describe('SiteService.create (#87)', () => {
  it('tenant_admin は拠点を作成でき、作成を監査する', async () => {
    const { svc, audits } = makeService();
    const r = await svc.create(tenantAdminA, { tenantId: T_A, name: ' 展示会ブース ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe('展示会ブース'); // trim
      expect(r.value.tenantId).toBe(T_A);
      expect(r.value.status).toBe('active');
    }
    expect(audits.map((a) => a.action)).toEqual(['site.created']);
  });

  it('viewer は書き込み不可（forbidden）', async () => {
    const { svc } = makeService();
    const r = await svc.create(viewerA, { tenantId: T_A, name: 'X' });
    expect(r).toEqual({ ok: false, error: { code: 'forbidden', message: expect.any(String) } });
  });

  it('他テナントへの作成は拒否（テナント越境）', async () => {
    const { svc } = makeService();
    const r = await svc.create(tenantAdminA, { tenantId: T_B, name: 'X' });
    expect(r.ok).toBe(false);
  });

  it('空名は invalid_input', async () => {
    const { svc } = makeService();
    const r = await svc.create(tenantAdminA, { tenantId: T_A, name: '   ' });
    expect(r).toEqual({ ok: false, error: { code: 'invalid_input', message: expect.any(String) } });
  });

  it('site_manager はテナント全体への作成権を持たない', async () => {
    const { svc } = makeService();
    const r = await svc.create(siteManagerA1, { tenantId: T_A, name: 'X' });
    expect(r.ok).toBe(false);
  });
});

describe('SiteService.update (#87)', () => {
  it('tenant_admin は名称・状態を更新でき監査する', async () => {
    const { svc, audits } = makeService();
    const r = await svc.update(tenantAdminA, T_A, S_A1, { name: '本社1F', status: 'suspended' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe('本社1F');
      expect(r.value.status).toBe('suspended');
      expect(r.value.updatedAt).toBe('2026-06-20T00:00:00.000Z');
    }
    expect(audits.map((a) => a.action)).toEqual(['site.updated']);
  });

  it('site_manager は自サイトを更新できる', async () => {
    const { svc } = makeService();
    const r = await svc.update(siteManagerA1, T_A, S_A1, { status: 'suspended' });
    expect(r.ok).toBe(true);
  });

  it('site_manager は権限外サイトを更新できない（forbidden）', async () => {
    const { svc } = makeService();
    const r = await svc.update(siteManagerA1, T_A, S_A2, { status: 'suspended' });
    expect(r).toEqual({ ok: false, error: { code: 'forbidden', message: expect.any(String) } });
  });

  it('viewer は更新不可（forbidden）', async () => {
    const { svc } = makeService();
    const r = await svc.update(viewerA, T_A, S_A1, { name: 'X' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('他テナントのサイト更新は拒否（テナント越境）', async () => {
    const { svc } = makeService();
    const r = await svc.update(tenantAdminA, T_B, S_B1, { name: 'X' });
    expect(r.ok).toBe(false);
  });

  it('存在しないサイトは not_found', async () => {
    const { svc } = makeService();
    const r = await svc.update(tenantAdminA, T_A, asSiteId('nope'), { name: 'X' });
    expect(r).toEqual({ ok: false, error: { code: 'not_found', message: expect.any(String) } });
  });

  it('空名への更新は invalid_input', async () => {
    const { svc } = makeService();
    const r = await svc.update(tenantAdminA, T_A, S_A1, { name: '  ' });
    expect(r).toEqual({ ok: false, error: { code: 'invalid_input', message: expect.any(String) } });
  });
});
