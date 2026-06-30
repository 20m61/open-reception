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

  it('無効化は保留中のエンロール URL を無効化する（再有効化で復活しない）', async () => {
    const { svc, store } = makeService();
    const issued = await svc.issueEnrollment(developer, T_A, D_A1);
    if (!issued.ok) throw new Error('issue failed');
    const jti = extractJti(issued.value.enrollment.token);

    // revoke で enrollmentTokenId が消える。
    await svc.setEnabled(tenantAdminA, T_A, D_A1, false);
    expect((await store.devices.getDevice(T_A, D_A1))?.enrollmentTokenId).toBeUndefined();

    // 再有効化しても旧 jti は consume 不可（復活しない）。
    await svc.setEnabled(tenantAdminA, T_A, D_A1, true);
    const consume = await svc.consumeEnrollment({
      tenantId: String(T_A),
      siteId: String(S_A1),
      deviceId: String(D_A1),
      jti,
    });
    expect(consume).toEqual({ ok: false, reason: 'used' });
  });
});

describe('DeviceService.issueEnrollment (受付発行)', () => {
  it('発行で enrollmentTokenId/tokenRegistered を立て、平文 token を一度だけ返す', async () => {
    const { svc } = makeService();
    const r = await svc.issueEnrollment(tenantAdminA, T_A, D_A1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.enrollment.token).toBeTruthy();
    expect(new Date(r.value.enrollment.expiresAt).getTime()).toBeGreaterThan(NOW.getTime());
    expect(r.value.view.tokenRegistered).toBe(true);
    // view（一覧/詳細に出る形）には平文 token を含めない。
    expect(r.value.view).not.toHaveProperty('token');
    expect(JSON.stringify(r.value.view)).not.toContain(r.value.enrollment.token);
  });

  it('監査 metadata に token 平文を残さない', async () => {
    const { svc, audits } = makeService();
    const r = await svc.issueEnrollment(tenantAdminA, T_A, D_A1);
    expect(r.ok).toBe(true);
    expect(audits.map((a) => a.action)).toEqual(['device.token_reissued']);
    const meta = audits[0]?.metadata ?? {};
    const token = r.ok ? r.value.enrollment.token : '';
    for (const [key, value] of Object.entries(meta)) {
      expect(key.toLowerCase()).not.toContain('token');
      expect(value).not.toBe(token);
    }
  });

  it('再発行は jti を更新し、旧 token を無効化する（consume 不可）', async () => {
    const { svc } = makeService();
    const first = await svc.issueEnrollment(tenantAdminA, T_A, D_A1);
    const second = await svc.issueEnrollment(tenantAdminA, T_A, D_A1);
    if (!first.ok || !second.ok) throw new Error('issue failed');
    // 旧 jti は consume できない（used）。
    const stale = await svc.consumeEnrollment({
      tenantId: String(T_A),
      siteId: String(S_A1),
      deviceId: String(D_A1),
      jti: extractJti(first.value.enrollment.token),
    });
    expect(stale).toEqual({ ok: false, reason: 'used' });
    // 新 jti は consume できる。
    const ok = await svc.consumeEnrollment({
      tenantId: String(T_A),
      siteId: String(S_A1),
      deviceId: String(D_A1),
      jti: extractJti(second.value.enrollment.token),
    });
    expect(ok.ok).toBe(true);
  });

  it('viewer は発行不可（forbidden）', async () => {
    const { svc } = makeService();
    const r = await svc.issueEnrollment(viewerA, T_A, D_A1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('他テナントの端末は発行できない（テナント越境 = not_found）', async () => {
    const { svc } = makeService();
    const r = await svc.issueEnrollment(tenantAdminA, T_B, D_B1);
    expect(r.ok).toBe(false);
  });
});

/** テスト補助: 署名トークンの payload から jti を取り出す（base64url の最初のセグメント）。 */
function extractJti(token: string): string {
  const body = token.split('.')[0] ?? '';
  const json = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return (JSON.parse(json) as { jti: string }).jti;
}

describe('DeviceService.consumeEnrollment (受付エンロール)', () => {
  async function issueJti(svc: DeviceService, tenantId = T_A, id = D_A1): Promise<string> {
    const r = await svc.issueEnrollment(developer, tenantId, id);
    if (!r.ok) throw new Error('issue failed');
    return extractJti(r.value.enrollment.token);
  }

  it('単回成功で kioskId を返し、jti を消去し lastSeenAt を更新する', async () => {
    const { svc, store } = makeService();
    const jti = await issueJti(svc);
    const r = await svc.consumeEnrollment({
      tenantId: String(T_A),
      siteId: String(S_A1),
      deviceId: String(D_A1),
      jti,
    });
    expect(r).toEqual({ ok: true, kioskId: String(D_A1) });
    const after = await store.devices.getDevice(T_A, D_A1);
    expect(after?.enrollmentTokenId).toBeUndefined();
    expect(after?.lastSeenAt).toBe(NOW.toISOString());
  });

  it('二度目の consume は used', async () => {
    const { svc } = makeService();
    const jti = await issueJti(svc);
    const claims = { tenantId: String(T_A), siteId: String(S_A1), deviceId: String(D_A1), jti };
    expect((await svc.consumeEnrollment(claims)).ok).toBe(true);
    expect(await svc.consumeEnrollment(claims)).toEqual({ ok: false, reason: 'used' });
  });

  it('同時2リクエストでも成功は1つだけ（CAS で二重消費を防止, #239）', async () => {
    const { svc } = makeService();
    const jti = await issueJti(svc);
    const claims = { tenantId: String(T_A), siteId: String(S_A1), deviceId: String(D_A1), jti };
    // 並行に2回消費（両者 read 時点では enrollmentTokenId=jti）。CAS により書込で勝てるのは1つ。
    const results = await Promise.all([svc.consumeEnrollment(claims), svc.consumeEnrollment(claims)]);
    const ok = results.filter((r) => r.ok);
    const used = results.filter((r) => !r.ok && r.reason === 'used');
    expect(ok).toHaveLength(1);
    expect(used).toHaveLength(1);
  });

  it('未発行端末（jti 不一致）は used', async () => {
    const { svc } = makeService();
    const r = await svc.consumeEnrollment({
      tenantId: String(T_A),
      siteId: String(S_A1),
      deviceId: String(D_A1),
      jti: 'never-issued',
    });
    expect(r).toEqual({ ok: false, reason: 'used' });
  });

  it('存在しない端末は not_found', async () => {
    const { svc } = makeService();
    const r = await svc.consumeEnrollment({
      tenantId: String(T_A),
      siteId: String(S_A1),
      deviceId: 'nope',
      jti: 'x',
    });
    expect(r).toEqual({ ok: false, reason: 'not_found' });
  });

  it('revoked 端末は発行 jti が一致しても revoked 拒否', async () => {
    const { svc } = makeService();
    // D_A2 は revoked。発行は write 認可で通るが consume で revoked 拒否。
    const r0 = await svc.issueEnrollment(developer, T_A, D_A2);
    if (!r0.ok) throw new Error('issue failed');
    const jti = extractJti(r0.value.enrollment.token);
    const r = await svc.consumeEnrollment({
      tenantId: String(T_A),
      siteId: String(S_A2),
      deviceId: String(D_A2),
      jti,
    });
    expect(r).toEqual({ ok: false, reason: 'revoked' });
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
