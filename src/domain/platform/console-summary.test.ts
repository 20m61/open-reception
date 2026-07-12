/**
 * プラットフォーム概況集計の単体テスト (issue #90, increment 1)。
 */
import { describe, expect, it } from 'vitest';
import {
  asDeviceId,
  asSiteId,
  asTenantId,
  type Device,
  type Site,
  type Tenant,
} from '@/domain/tenant/types';
import type { AuditLog } from '@/domain/reception/log';
import {
  maskAuditActor,
  summarizeMaintenance,
  summarizeTenantDetail,
  summarizeTenantFleet,
  toAuthMethodStatusRows,
  summarizeExperienceAcrossTenants,
  toIntegrationStatusRows,
  toMaskedAuditRows,
  toTenantRows,
} from './console-summary';
import type { ReceptionExperience, ReceptionLog } from '@/domain/reception/log';

function tenant(args: {
  id: string;
  name: string;
  slug: string;
  status: Tenant['status'];
}): Tenant {
  return {
    id: asTenantId(args.id),
    name: args.name,
    slug: args.slug,
    status: args.status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
}

function rlog(
  id: string,
  outcome: ReceptionLog['outcome'],
  experience?: ReceptionExperience,
): ReceptionLog {
  return {
    id,
    receptionId: `rcp-${id}`,
    kioskId: 'kiosk-1',
    outcome,
    fallbackUsed: false,
    startedAt: '2026-07-11T00:00:00.000Z',
    endedAt: '2026-07-11T00:00:05.000Z',
    durationMs: 5000,
    createdAt: '2026-07-11T00:00:05.000Z',
    ...(experience ? { experience } : {}),
  };
}

describe('summarizeExperienceAcrossTenants (#319/#284)', () => {
  it('空エントリはゼロ値サマリ', () => {
    const s = summarizeExperienceAcrossTenants([]);
    expect(s.perTenant).toEqual([]);
    expect(s.overall.total).toBe(0);
    expect(s.overall.callStartWithin30sRate).toBeNull();
  });

  it('全テナント合算と、テナント別行（measured 降順）を返す。PII を含まない', () => {
    const s = summarizeExperienceAcrossTenants([
      {
        tenant: { id: asTenantId('t1'), name: 'Alpha' },
        logs: [
          rlog('a', 'connected', { timeToCallMs: 10000 }),
          rlog('b', 'timeout', { timeToCallMs: 40000 }),
        ],
      },
      {
        tenant: { id: asTenantId('t2'), name: 'Bravo' },
        logs: [rlog('c', 'connected', { timeToCallMs: 5000 })],
      },
    ]);
    // 合算: 呼び出し到達 3 件中 30 秒以内 2 件。
    expect(s.overall.callStartWithin30s).toEqual({ within: 2, reached: 3 });
    expect(s.overall.total).toBe(3);
    // テナント別は measured 降順（t1=2 → t2=1）。
    expect(s.perTenant.map((r) => r.tenantId)).toEqual(['t1', 't2']);
    expect(s.perTenant[0]).toMatchObject({ tenantName: 'Alpha', measured: 2 });
    expect(s.perTenant[1]).toMatchObject({ tenantName: 'Bravo', measured: 1 });
    // PII らしきキーを含まない（数値/文字列 id・名前のみ）。
    expect(JSON.stringify(s)).not.toMatch(/name":"[^"]*(?:様|さん)/);
  });
});

describe('summarizeTenantFleet', () => {
  it('counts total / active / suspended', () => {
    const summary = summarizeTenantFleet([
      tenant({ id: 'a', name: 'A', slug: 'a', status: 'active' }),
      tenant({ id: 'b', name: 'B', slug: 'b', status: 'active' }),
      tenant({ id: 'c', name: 'C', slug: 'c', status: 'suspended' }),
    ]);
    expect(summary).toEqual({ total: 3, active: 2, suspended: 1 });
  });

  it('handles empty fleet', () => {
    expect(summarizeTenantFleet([])).toEqual({ total: 0, active: 0, suspended: 0 });
  });
});

describe('toTenantRows', () => {
  it('projects only non-sensitive metadata and sorts by name then id', () => {
    const rows = toTenantRows([
      tenant({ id: 'z', name: 'Zebra', slug: 'zebra', status: 'active' }),
      tenant({ id: 'a', name: 'Alpha', slug: 'alpha', status: 'suspended' }),
    ]);
    expect(rows.map((r) => r.name)).toEqual(['Alpha', 'Zebra']);
    const first = rows[0];
    expect(first).toEqual({
      id: 'a',
      name: 'Alpha',
      slug: 'alpha',
      status: 'suspended',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    // PII/機密値や createdAt 等の内部情報を含めない。
    expect(Object.keys(first ?? {}).sort()).toEqual(['id', 'name', 'slug', 'status', 'updatedAt']);
  });
});

/* ===================== increment 2 ===================== */

function site(args: { id: string; name: string; status: Site['status'] }): Site {
  return {
    id: asSiteId(args.id),
    tenantId: asTenantId('t'),
    name: args.name,
    status: args.status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
}

function device(args: {
  id: string;
  siteId: string;
  name: string;
  status: Device['status'];
  maintenance?: boolean;
}): Device {
  return {
    id: asDeviceId(args.id),
    tenantId: asTenantId('t'),
    siteId: asSiteId(args.siteId),
    name: args.name,
    status: args.status,
    maintenance: args.maintenance,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
}

describe('summarizeTenantDetail', () => {
  it('aggregates site/device counts and statuses without PII/secrets', () => {
    const t = tenant({ id: 't', name: 'T', slug: 't', status: 'active' });
    const detail = summarizeTenantDetail(t, [
      {
        site: site({ id: 's2', name: 'Beta', status: 'active' }),
        devices: [
          device({ id: 'd1', siteId: 's2', name: 'D1', status: 'active' }),
          device({ id: 'd2', siteId: 's2', name: 'D2', status: 'revoked', maintenance: true }),
        ],
      },
      {
        site: site({ id: 's1', name: 'Alpha', status: 'suspended' }),
        devices: [device({ id: 'd3', siteId: 's1', name: 'D3', status: 'active', maintenance: true })],
      },
    ]);

    expect(detail.siteCount).toBe(2);
    expect(detail.deviceCount).toBe(3);
    expect(detail.activeDeviceCount).toBe(2);
    expect(detail.maintenanceDeviceCount).toBe(2);
    // サイトは名前順に安定ソート。
    expect(detail.sites.map((s) => s.name)).toEqual(['Alpha', 'Beta']);
    expect(detail.sites[0]).toEqual({
      id: 's1',
      name: 'Alpha',
      status: 'suspended',
      deviceCount: 1,
      activeDeviceCount: 1,
    });
    // メタ情報のみ（token 等の機密を含めない）。
    expect(Object.keys(detail.sites[0] ?? {}).sort()).toEqual([
      'activeDeviceCount',
      'deviceCount',
      'id',
      'name',
      'status',
    ]);
  });

  it('handles tenant with no sites', () => {
    const detail = summarizeTenantDetail(tenant({ id: 't', name: 'T', slug: 't', status: 'active' }), []);
    expect(detail).toMatchObject({ siteCount: 0, deviceCount: 0, activeDeviceCount: 0, maintenanceDeviceCount: 0, sites: [] });
  });
});

describe('summarizeMaintenance', () => {
  it('extracts only maintenance devices across tenants, sorted, without PII', () => {
    const ta = tenant({ id: 'ta', name: 'Beta社', slug: 'beta', status: 'active' });
    const tb = tenant({ id: 'tb', name: 'Alpha社', slug: 'alpha', status: 'active' });
    const summary = summarizeMaintenance([
      {
        tenant: ta,
        devices: [
          device({ id: 'd1', siteId: 's1', name: '端末1', status: 'active', maintenance: true }),
          device({ id: 'd2', siteId: 's1', name: '端末2', status: 'active', maintenance: false }),
        ],
      },
      {
        tenant: tb,
        devices: [device({ id: 'd3', siteId: 's2', name: '端末3', status: 'active', maintenance: true })],
      },
    ]);
    expect(summary.devicesInMaintenance).toBe(2);
    // テナント名 → 端末名 の安定ソート（Alpha社 が先）。
    expect(summary.devices.map((d) => d.tenantName)).toEqual(['Alpha社', 'Beta社']);
    expect(summary.devices[0]).toEqual({
      tenantId: 'tb',
      tenantName: 'Alpha社',
      siteId: 's2',
      deviceId: 'd3',
      deviceName: '端末3',
    });
  });

  it('returns empty when nothing is in maintenance', () => {
    const summary = summarizeMaintenance([
      {
        tenant: tenant({ id: 't', name: 'T', slug: 't', status: 'active' }),
        devices: [device({ id: 'd', siteId: 's', name: 'D', status: 'active' })],
      },
    ]);
    expect(summary).toEqual({ devicesInMaintenance: 0, devices: [] });
  });
});

describe('maskAuditActor', () => {
  it('masks the identifier part but keeps the kind label', () => {
    expect(maskAuditActor('kiosk:device-123')).toBe('kiosk:***');
    expect(maskAuditActor('admin:user@example.com')).toBe('admin:***');
  });
  it('leaves plain labels (no identifier) unchanged', () => {
    expect(maskAuditActor('admin')).toBe('admin');
  });
});

describe('toMaskedAuditRows', () => {
  it('projects masked minimal rows and drops metadata', () => {
    const logs: AuditLog[] = [
      {
        id: '1',
        action: 'reception.connected',
        actor: 'kiosk:dev-1',
        targetType: 'reception',
        targetId: 'r1',
        at: '2026-06-01T00:00:00.000Z',
        metadata: { failureReason: 'secret-ish' },
      },
    ];
    const rows = toMaskedAuditRows(logs);
    expect(rows[0]).toEqual({
      id: '1',
      at: '2026-06-01T00:00:00.000Z',
      action: 'reception.connected',
      actor: 'kiosk:***',
      targetType: 'reception',
      targetId: 'r1',
    });
    // metadata は表示行に載せない。
    expect('metadata' in (rows[0] ?? {})).toBe(false);
  });

  it('高詳細監査フィールド（ip/userAgent/before/after）を射影する（#83 AC13）', () => {
    const logs: AuditLog[] = [
      {
        id: '2',
        action: 'tenant.suspended',
        actor: 'admin:ops@example.com',
        targetType: 'tenant',
        targetId: 't1',
        at: '2026-06-02T00:00:00.000Z',
        ip: '203.0.113.4',
        userAgent: 'UA/1.0',
        before: { status: 'active' },
        after: { status: 'suspended' },
      },
    ];
    const row = toMaskedAuditRows(logs)[0]!;
    expect(row.actor).toBe('admin:***'); // actor はマスク維持。
    expect(row.ip).toBe('203.0.113.4');
    expect(row.userAgent).toBe('UA/1.0');
    expect(row.before).toEqual({ status: 'active' });
    expect(row.after).toEqual({ status: 'suspended' });
    // metadata は依然として載せない。
    expect('metadata' in row).toBe(false);
  });
});

describe('toIntegrationStatusRows (increment 3)', () => {
  it('label 昇順で表示用フィールドのみを射影し、想定外フィールドは落とす', () => {
    const rows = toIntegrationStatusRows([
      {
        id: 'vonage',
        label: 'Vonage',
        configured: true,
        enabled: false,
        lastResult: 'failure',
        lastFailureAt: '2026-06-01T00:00:00.000Z',
        lastErrorSummary: 'auth failed',
        // @ts-expect-error 機密が将来混入しても射影が落とすことを確認する。
        apiSecret: 'SHOULD-NOT-LEAK',
      },
      { id: 'aws', label: 'AWS', configured: false, enabled: false, lastResult: 'untested' },
    ]);
    expect(rows.map((r) => r.label)).toEqual(['AWS', 'Vonage']);
    expect('apiSecret' in (rows[1] ?? {})).toBe(false);
    expect(JSON.stringify(rows)).not.toContain('SHOULD-NOT-LEAK');
    expect(rows[1]).toMatchObject({ id: 'vonage', lastErrorSummary: 'auth failed' });
  });
});

describe('toAuthMethodStatusRows (increment 3)', () => {
  it('label 昇順で射影し issues を複製して返す', () => {
    const source = [
      { id: 'password', label: '共有パスワード', enabled: false, issues: ['未設定'] },
      { id: 'entra', label: 'Entra ID', enabled: true, issues: [] },
    ];
    const rows = toAuthMethodStatusRows(source);
    expect(rows.map((r) => r.id)).toEqual(['entra', 'password']);
    // issues は複製（元配列への参照を共有しない）。
    expect(rows[1]?.issues).toEqual(['未設定']);
    expect(rows[1]?.issues).not.toBe(source[0]?.issues);
  });
});
