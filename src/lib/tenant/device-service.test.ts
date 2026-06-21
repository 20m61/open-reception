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
import { MemoryTenantStore } from './memory-repository';
import { DeviceService } from './device-service';
import type { AppendAudit } from './site-service';

const T_A = asTenantId('tenant-a');
const T_B = asTenantId('tenant-b');
const S_A1 = asSiteId('site-a1');
const S_A2 = asSiteId('site-a2');
const S_B1 = asSiteId('site-b1');
const D_A1 = asDeviceId('dev-a1');
const D_A2 = asDeviceId('dev-a2');
const D_B1 = asDeviceId('dev-b1');

const NOW = new Date('2026-06-20T12:00:00.000Z');

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

function site(id: typeof S_A1, tenantId = T_A): Site {
  return {
    id,
    tenantId,
    name: id,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}
function device(over: Partial<Device> & Pick<Device, 'id' | 'tenantId' | 'siteId'>): Device {
  return {
    name: over.id,
    status: 'active',
    tokenRegistered: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function makeService() {
  const audits: Array<{ action: AuditAction; metadata?: Record<string, string> }> = [];
  const appendAudit: AppendAudit = vi.fn(async (action, _t, metadata) => {
    audits.push({ action, metadata });
  });
  const store = new MemoryTenantStore({
    sites: [site(S_A1), site(S_A2), site(S_B1, T_B)],
    devices: [
      device({ id: D_A1, tenantId: T_A, siteId: S_A1, name: '受付1' }),
      device({ id: D_A2, tenantId: T_A, siteId: S_A2, name: '受付2', status: 'revoked' }),
      device({ id: D_B1, tenantId: T_B, siteId: S_B1, name: '他社' }),
    ],
  });
  const svc = new DeviceService({
    devices: store.devices,
    sites: store.sites,
    appendAudit,
    now: () => NOW,
  });
  return { svc, audits, store };
}

describe('DeviceService.list (#87 inc2)', () => {
  it('サイト配下の端末を返す', async () => {
    const { svc } = makeService();
    const r = await svc.list(tenantAdminA, T_A, S_A1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((d) => d.id)).toEqual([D_A1]);
  });

  it('site_manager は権限外サイトを一覧できない（forbidden）', async () => {
    const { svc } = makeService();
    const r = await svc.list(siteManagerA1, T_A, S_A2);
    expect(r).toEqual({ ok: false, error: { code: 'forbidden', message: expect.any(String) } });
  });

  it('テナント越境は拒否', async () => {
    const { svc } = makeService();
    const r = await svc.list(tenantAdminA, T_B, S_B1);
    expect(r.ok).toBe(false);
  });

  it('稼働状態を派生する（revoked=disabled / heartbeat なし=offline）', async () => {
    const { svc } = makeService();
    const a1 = await svc.list(developer, T_A, S_A1);
    const a2 = await svc.list(developer, T_A, S_A2);
    if (a1.ok) expect(a1.value[0]?.connectivity).toBe('offline');
    if (a2.ok) expect(a2.value[0]?.connectivity).toBe('disabled');
  });

  it('新しい heartbeat はオンライン、古い heartbeat はオフライン', async () => {
    const { store } = makeService();
    await store.devices.putDevice(
      device({ id: D_A1, tenantId: T_A, siteId: S_A1, lastSeenAt: NOW.toISOString() }),
    );
    const svc = new DeviceService({
      devices: store.devices,
      sites: store.sites,
      appendAudit: vi.fn(),
      now: () => NOW,
    });
    const fresh = await svc.list(developer, T_A, S_A1);
    if (fresh.ok) expect(fresh.value[0]?.connectivity).toBe('online');

    await store.devices.putDevice(
      device({ id: D_A1, tenantId: T_A, siteId: S_A1, lastSeenAt: '2026-06-20T11:00:00.000Z' }),
    );
    const stale = await svc.list(developer, T_A, S_A1);
    if (stale.ok) expect(stale.value[0]?.connectivity).toBe('offline');
  });
});

describe('DeviceService.create (#87 inc2)', () => {
  it('tenant_admin は端末を登録できる（token 未登録で開始）', async () => {
    const { svc } = makeService();
    const r = await svc.create(tenantAdminA, {
      tenantId: T_A,
      siteId: S_A1,
      name: ' 新端末 ',
      location: ' 2F ',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe('新端末');
      expect(r.value.location).toBe('2F');
      expect(r.value.kind).toBe('kiosk');
      expect(r.value.tokenRegistered).toBe(false);
      expect(r.value.status).toBe('active');
    }
  });

  it('site_manager は自サイトに登録できる', async () => {
    const { svc } = makeService();
    const r = await svc.create(siteManagerA1, { tenantId: T_A, siteId: S_A1, name: 'X' });
    expect(r.ok).toBe(true);
  });

  it('site_manager は権限外サイトに登録できない（forbidden）', async () => {
    const { svc } = makeService();
    const r = await svc.create(siteManagerA1, { tenantId: T_A, siteId: S_A2, name: 'X' });
    expect(r).toEqual({ ok: false, error: { code: 'forbidden', message: expect.any(String) } });
  });

  it('viewer は書込不可（forbidden）', async () => {
    const { svc } = makeService();
    const r = await svc.create(viewerA, { tenantId: T_A, siteId: S_A1, name: 'X' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('他テナントへの登録は拒否（テナント越境）', async () => {
    const { svc } = makeService();
    const r = await svc.create(tenantAdminA, { tenantId: T_B, siteId: S_B1, name: 'X' });
    expect(r.ok).toBe(false);
  });

  it('存在しないサイトには登録できない（not_found）', async () => {
    const { svc } = makeService();
    const r = await svc.create(tenantAdminA, { tenantId: T_A, siteId: asSiteId('nope'), name: 'X' });
    expect(r).toEqual({ ok: false, error: { code: 'not_found', message: expect.any(String) } });
  });

  it('空名は invalid_input', async () => {
    const { svc } = makeService();
    const r = await svc.create(tenantAdminA, { tenantId: T_A, siteId: S_A1, name: '   ' });
    expect(r).toEqual({ ok: false, error: { code: 'invalid_input', message: expect.any(String) } });
  });
});

describe('DeviceService.update (#87 inc2)', () => {
  it('tenant_admin は名称・設置場所・種別・メンテ表示を更新できる', async () => {
    const { svc } = makeService();
    const r = await svc.update(tenantAdminA, T_A, D_A1, {
      name: '受付1F',
      location: 'ロビー',
      kind: 'tablet',
      maintenance: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe('受付1F');
      expect(r.value.location).toBe('ロビー');
      expect(r.value.kind).toBe('tablet');
      expect(r.value.maintenance).toBe(true);
      expect(r.value.connectivity).toBe('maintenance');
    }
  });

  it('viewer は更新不可（forbidden）', async () => {
    const { svc } = makeService();
    const r = await svc.update(viewerA, T_A, D_A1, { name: 'X' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('他テナントの端末は更新できない（テナント越境 = not_found）', async () => {
    const { svc } = makeService();
    const r = await svc.update(tenantAdminA, T_B, D_B1, { name: 'X' });
    expect(r.ok).toBe(false);
  });

  it('空名への更新は invalid_input', async () => {
    const { svc } = makeService();
    const r = await svc.update(tenantAdminA, T_A, D_A1, { name: ' ' });
    expect(r).toEqual({ ok: false, error: { code: 'invalid_input', message: expect.any(String) } });
  });
});

describe('DeviceService.setEnabled (#87 inc2)', () => {
  it('無効化すると status=revoked になり device.disabled を監査する', async () => {
    const { svc, audits } = makeService();
    const r = await svc.setEnabled(tenantAdminA, T_A, D_A1, false);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.status).toBe('revoked');
      expect(r.value.connectivity).toBe('disabled');
    }
    expect(audits.map((a) => a.action)).toEqual(['device.disabled']);
  });

  it('有効化すると status=active になり device.enabled を監査する', async () => {
    const { svc, audits } = makeService();
    const r = await svc.setEnabled(tenantAdminA, T_A, D_A2, true);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.status).toBe('active');
    expect(audits.map((a) => a.action)).toEqual(['device.enabled']);
  });

  it('viewer は切り替え不可（forbidden）', async () => {
    const { svc } = makeService();
    const r = await svc.setEnabled(viewerA, T_A, D_A1, false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });
});

describe('DeviceService.reissueToken (#87 inc2)', () => {
  it('再発行で tokenRegistered=true になり device.token_reissued を監査する', async () => {
    const { svc, audits } = makeService();
    // まず未登録状態にしておく。
    const created = await svc.create(tenantAdminA, { tenantId: T_A, siteId: S_A1, name: '新' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const r = await svc.reissueToken(tenantAdminA, T_A, created.value.id);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.tokenRegistered).toBe(true);
    expect(audits.map((a) => a.action)).toEqual(['device.token_reissued']);
  });

  it('監査・レスポンスに token 平文を含めない', async () => {
    const { svc, audits } = makeService();
    const r = await svc.reissueToken(tenantAdminA, T_A, D_A1);
    expect(r.ok).toBe(true);
    // レスポンスに token 系フィールドが無いこと。
    if (r.ok) {
      expect(r.value).not.toHaveProperty('token');
      expect(r.value).not.toHaveProperty('tokenHash');
      expect(r.value).not.toHaveProperty('secret');
    }
    // 監査 metadata に token 系の値が無いこと。
    const meta = audits[0]?.metadata ?? {};
    for (const key of Object.keys(meta)) {
      expect(key.toLowerCase()).not.toContain('token');
      expect(key.toLowerCase()).not.toContain('secret');
    }
  });

  it('viewer は再発行不可（forbidden）', async () => {
    const { svc } = makeService();
    const r = await svc.reissueToken(viewerA, T_A, D_A1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('他テナントの端末は再発行できない（テナント越境）', async () => {
    const { svc } = makeService();
    const r = await svc.reissueToken(tenantAdminA, T_B, D_B1);
    expect(r.ok).toBe(false);
  });
});

describe('DeviceService.recordHeartbeat (#87 inc3 Kiosk→Device 統合)', () => {
  it('kiosk id 一致の Device に lastSeenAt を記録し online になる', async () => {
    const { svc, store } = makeService();
    // 初期は heartbeat 未着で offline。
    const before = await svc.list(developer, T_A, S_A1);
    if (before.ok) expect(before.value[0]?.connectivity).toBe('offline');

    // kiosk heartbeat（id = device id）→ lastSeenAt 記録。
    const res = await svc.recordHeartbeat(String(D_A1), NOW);
    expect(res).toEqual({ matched: true });

    const after = await svc.list(developer, T_A, S_A1);
    if (after.ok) {
      expect(after.value[0]?.connectivity).toBe('online');
      expect(after.value[0]?.lastSeenAt).toBe(NOW.toISOString());
    }
    // 直接ストアでも反映を確認。
    const persisted = await store.devices.getDevice(T_A, D_A1);
    expect(persisted?.lastSeenAt).toBe(NOW.toISOString());
  });

  it('対応 Device が無い kiosk は matched:false（no-op）', async () => {
    const { svc } = makeService();
    const res = await svc.recordHeartbeat('kiosk-unknown', NOW);
    expect(res).toEqual({ matched: false });
  });

  it('空 id は matched:false（ストアを引かない）', async () => {
    const { svc } = makeService();
    expect(await svc.recordHeartbeat('  ', NOW)).toEqual({ matched: false });
  });

  it('heartbeat は status を変えない（revoked は disabled のまま）', async () => {
    const { svc } = makeService();
    // D_A2 は revoked。heartbeat が来ても有効化しない。
    const res = await svc.recordHeartbeat(String(D_A2), NOW);
    expect(res).toEqual({ matched: true });
    const after = await svc.list(developer, T_A, S_A2);
    if (after.ok) {
      expect(after.value[0]?.status).toBe('revoked');
      expect(after.value[0]?.connectivity).toBe('disabled');
    }
  });
});
