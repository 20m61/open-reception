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
import { __resetBackend, getBackend } from '@/lib/data';
import { DataBackedTenantStore, DEVICE_COLLECTION } from './data-repository';
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
  // §9 標準（#274）: エンティティ専用の in-memory repository は持たない。
  // memory backend + seed で DataBacked 実装をそのままテストする（テスト毎に backend を作り直す）。
  __resetBackend();
  const store = new DataBackedTenantStore({
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
    // 世代を持たない旧レコードは 0 として読み、消費で 1 へ上がる (#1237)。
    expect(r).toEqual({ ok: true, kioskId: String(D_A1), credentialGeneration: 1 });
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

  it('heartbeat は enrollmentTokenId を復活させない（lastSeenAt のみ部分更新, #239）', async () => {
    const { svc, store } = makeService();
    // 発行→消費で enrollmentTokenId は消去済み。
    const r0 = await svc.issueEnrollment(developer, T_A, D_A1);
    if (!r0.ok) throw new Error('issue failed');
    const jti = extractJti(r0.value.enrollment.token);
    await svc.consumeEnrollment({
      tenantId: String(T_A),
      siteId: String(S_A1),
      deviceId: String(D_A1),
      jti,
    });
    expect((await store.devices.getDevice(T_A, D_A1))?.enrollmentTokenId).toBeUndefined();

    // 全置換 put なら stale な enrollmentTokenId を書き戻し得るが、部分更新なので消えたまま。
    await svc.recordHeartbeat(String(D_A1), NOW);
    const after = await store.devices.getDevice(T_A, D_A1);
    expect(after?.enrollmentTokenId).toBeUndefined();
    expect(after?.lastSeenAt).toBe(NOW.toISOString());
  });
});

describe('DeviceService.adoptKiosk (#261 kiosk-only 端末の Device 取り込み)', () => {
  const SCOPE = { tenantId: T_A, siteId: S_A1 };

  it('kiosk レジストリのみの端末を Device として作成し、heartbeat を稼働反映する', async () => {
    const { svc, store } = makeService();
    const res = await svc.adoptKiosk(
      { id: 'kiosk-legacy', displayName: '旧受付端末', location: '2F', enabled: true },
      SCOPE,
      NOW,
    );
    expect(res).toEqual({ created: true });
    const created = await store.devices.getDevice(T_A, asDeviceId('kiosk-legacy'));
    expect(created).toMatchObject({
      id: 'kiosk-legacy',
      tenantId: T_A,
      siteId: S_A1,
      name: '旧受付端末',
      location: '2F',
      kind: 'kiosk',
      status: 'active',
      lastSeenAt: NOW.toISOString(),
    });
  });

  it('失効中（enabled=false）の kiosk は revoked として取り込む（勝手に有効化しない）', async () => {
    const { svc, store } = makeService();
    const res = await svc.adoptKiosk(
      { id: 'kiosk-off', displayName: '停止端末', enabled: false },
      SCOPE,
      NOW,
    );
    expect(res).toEqual({ created: true });
    expect((await store.devices.getDevice(T_A, asDeviceId('kiosk-off')))?.status).toBe('revoked');
  });

  it('既に Device が存在する id は no-op（冪等・上書きしない）', async () => {
    const { svc, store } = makeService();
    const res = await svc.adoptKiosk(
      { id: String(D_A1), displayName: '別名で上書きしようとする', enabled: false },
      SCOPE,
      NOW,
    );
    expect(res).toEqual({ created: false });
    const existing = await store.devices.getDevice(T_A, D_A1);
    expect(existing?.name).toBe('受付1');
    expect(existing?.status).toBe('active');
  });

  it('空 id / 空表示名は取り込まない', async () => {
    const { svc } = makeService();
    expect(await svc.adoptKiosk({ id: '  ', displayName: 'x', enabled: true }, SCOPE)).toEqual({
      created: false,
    });
    expect(
      await svc.adoptKiosk({ id: 'kiosk-x', displayName: '  ', enabled: true }, SCOPE),
    ).toEqual({ created: false });
  });

  it('監査は記録しない（actor 不在のシステム由来同期）', async () => {
    const { svc, audits } = makeService();
    await svc.adoptKiosk({ id: 'kiosk-legacy', displayName: '旧受付端末', enabled: true }, SCOPE);
    expect(audits).toEqual([]);
  });
});

describe('DeviceService.syncKioskState (#284 inc1 /admin/kiosks の逆方向即時同期)', () => {
  const SCOPE = { tenantId: T_A, siteId: S_A1 };

  it('対応 Device が無い kiosk は Device を作成する（lastSeenAt は付けない = heartbeat 前は offline）', async () => {
    const { svc, store } = makeService();
    const res = await svc.syncKioskState(
      { id: 'kiosk-new', displayName: '新端末', location: '3F', enabled: true },
      SCOPE,
    );
    expect(res).toEqual({ created: true, updated: false });
    const created = await store.devices.getDevice(T_A, asDeviceId('kiosk-new'));
    expect(created).toMatchObject({
      id: 'kiosk-new',
      tenantId: T_A,
      siteId: S_A1,
      name: '新端末',
      location: '3F',
      kind: 'kiosk',
      status: 'active',
    });
    // adoptKiosk（heartbeat 起点）と違い、管理操作の作成は稼働の証跡ではないので lastSeenAt を残さない。
    expect(created?.lastSeenAt).toBeUndefined();
  });

  it('enabled=false の kiosk は revoked として作成する（#283 と同じ写像規則）', async () => {
    const { svc, store } = makeService();
    const res = await svc.syncKioskState(
      { id: 'kiosk-off', displayName: '停止端末', enabled: false },
      SCOPE,
    );
    expect(res).toEqual({ created: true, updated: false });
    expect((await store.devices.getDevice(T_A, asDeviceId('kiosk-off')))?.status).toBe('revoked');
  });

  it('既存 Device の status を enabled に合わせて更新する（revoke の即時写像）', async () => {
    const { svc, store } = makeService();
    const res = await svc.syncKioskState(
      { id: String(D_A1), displayName: '受付1', enabled: false },
      SCOPE,
    );
    expect(res).toEqual({ created: false, updated: true });
    const after = await store.devices.getDevice(T_A, D_A1);
    expect(after?.status).toBe('revoked');
    expect(after?.updatedAt).toBe(NOW.toISOString());
  });

  it('status 更新時は保留中エンロール URL を無効化する（setEnabled と同じ規則）', async () => {
    const { svc, store } = makeService();
    await store.devices.putDevice(
      device({ id: D_A1, tenantId: T_A, siteId: S_A1, enrollmentTokenId: 'jti-pending' }),
    );
    await svc.syncKioskState({ id: String(D_A1), displayName: '受付1', enabled: false }, SCOPE);
    expect((await store.devices.getDevice(T_A, D_A1))?.enrollmentTokenId).toBeUndefined();
  });

  it('status が既に一致していれば no-op（冪等・名称等は上書きしない）', async () => {
    const { svc, store } = makeService();
    const res = await svc.syncKioskState(
      { id: String(D_A1), displayName: '別名で上書きしようとする', enabled: true },
      SCOPE,
    );
    expect(res).toEqual({ created: false, updated: false });
    const after = await store.devices.getDevice(T_A, D_A1);
    expect(after?.name).toBe('受付1');
    expect(after?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('既存 Device の更新でも表示メタ（name/location）は kiosk 側で上書きしない', async () => {
    const { svc, store } = makeService();
    await svc.syncKioskState(
      { id: String(D_A1), displayName: '別名', location: '別の場所', enabled: false },
      SCOPE,
    );
    const after = await store.devices.getDevice(T_A, D_A1);
    expect(after?.name).toBe('受付1');
    expect(after?.location).toBeUndefined();
  });

  it('空 id / 空表示名は同期しない', async () => {
    const { svc } = makeService();
    expect(await svc.syncKioskState({ id: '  ', displayName: 'x', enabled: true }, SCOPE)).toEqual(
      { created: false, updated: false },
    );
    expect(
      await svc.syncKioskState({ id: 'kiosk-x', displayName: '  ', enabled: true }, SCOPE),
    ).toEqual({ created: false, updated: false });
  });

  it('監査は記録しない（kiosk 管理 API 側の kiosk.* 監査に一本化）', async () => {
    const { svc, audits } = makeService();
    await svc.syncKioskState({ id: 'kiosk-new', displayName: '新端末', enabled: true }, SCOPE);
    await svc.syncKioskState({ id: String(D_A1), displayName: '受付1', enabled: false }, SCOPE);
    expect(audits).toEqual([]);
  });
});

describe('端末証明の世代 (#1237)', () => {
  const claimsFor = (jti: string) => ({
    tenantId: String(T_A),
    siteId: String(S_A1),
    deviceId: String(D_A1),
    jti,
  });
  async function enroll(svc: DeviceService) {
    const r = await svc.issueEnrollment(developer, T_A, D_A1);
    if (!r.ok) throw new Error('issue failed');
    return svc.consumeEnrollment(claimsFor(extractJti(r.value.enrollment.token)));
  }

  it('🔴 再登録のたびに世代が上がり、台帳と返り値が一致する', async () => {
    const { svc, store } = makeService();
    const first = await enroll(svc);
    const second = await enroll(svc);
    expect(first).toMatchObject({ ok: true, credentialGeneration: 1 });
    expect(second).toMatchObject({ ok: true, credentialGeneration: 2 });
    expect((await store.devices.getDevice(T_A, D_A1))?.credentialGeneration).toBe(2);
  });

  it('既存の世代から上げる（旧レコードの 0 ではなく現在値 + 1）', async () => {
    const { svc, store } = makeService();
    await store.devices.putDevice(
      device({ id: D_A1, tenantId: T_A, siteId: S_A1, credentialGeneration: 7 }),
    );
    expect(await enroll(svc)).toMatchObject({ ok: true, credentialGeneration: 8 });
  });

  it('🔴 失効で世代が上がり、再有効化でもさらに上がる', async () => {
    const { svc, store } = makeService();
    await enroll(svc); // 1
    await svc.setEnabled(tenantAdminA, T_A, D_A1, false);
    expect((await store.devices.getDevice(T_A, D_A1))?.credentialGeneration).toBe(2);
    await svc.setEnabled(tenantAdminA, T_A, D_A1, true);
    expect((await store.devices.getDevice(T_A, D_A1))?.credentialGeneration).toBe(3);
  });

  it('状態が変わらない setEnabled では世代を据え置く（下界）', async () => {
    const { svc, store } = makeService();
    await enroll(svc); // 1
    await svc.setEnabled(tenantAdminA, T_A, D_A1, true);
    expect((await store.devices.getDevice(T_A, D_A1))?.credentialGeneration).toBe(1);
  });

  it('🔴 /admin/kiosks からの失効（syncKioskState）でも世代が上がる', async () => {
    const { svc, store } = makeService();
    await enroll(svc); // 1
    await svc.syncKioskState(
      { id: String(D_A1), displayName: '受付1', enabled: false },
      { tenantId: T_A, siteId: S_A1 },
    );
    expect((await store.devices.getDevice(T_A, D_A1))?.credentialGeneration).toBe(2);
  });

  it('🔴 読んだあとに世代が変わっていたら消費しない（CAS は世代も条件にする）', async () => {
    const { svc, store } = makeService();
    const r = await svc.issueEnrollment(developer, T_A, D_A1);
    if (!r.ok) throw new Error('issue failed');
    const jti = extractJti(r.value.enrollment.token);
    // 消費の read と write の間に世代だけが変わった状態を、リポジトリを直接叩いて作る。
    const won = await store.devices.consumeEnrollment(D_A1, jti, NOW.toISOString(), {
      expected: 5,
      next: 6,
    });
    expect(won).toBe(false);
    const after = await store.devices.getDevice(T_A, D_A1);
    expect(after?.enrollmentTokenId).toBe(jti);
    expect(after?.credentialGeneration).toBeUndefined();
  });

  it('🔴 未設定を期待したのに世代が付いていたら消費しない（attribute_not_exists 側）', async () => {
    const { svc, store } = makeService();
    const r = await svc.issueEnrollment(developer, T_A, D_A1);
    if (!r.ok) throw new Error('issue failed');
    const jti = extractJti(r.value.enrollment.token);
    const current = await store.devices.getDevice(T_A, D_A1);
    await store.devices.putDevice({ ...current!, credentialGeneration: 2 });
    const won = await store.devices.consumeEnrollment(D_A1, jti, NOW.toISOString(), {
      expected: undefined,
      next: 1,
    });
    expect(won).toBe(false);
    expect((await store.devices.getDevice(T_A, D_A1))?.credentialGeneration).toBe(2);
  });
});

describe('管理操作とエンロールの消費が競合しても世代を巻き戻さない (#1237 follow-up)', () => {
  /**
   * 不変条件: 管理操作の read と write の間にエンロールの消費が割り込んでも、
   *   (a) 台帳の世代は、消費が発行した証明の世代を下回らない（巻き戻らない）
   *   (b) 登録状態を切り替える操作なら、世代はその証明の世代より大きい（切替前の証明を通さない）
   *   (c) 割り込みが無い場合と同じ status に落ち着く
   * 管理操作が端末を最初に読んだ直後に、保留中の URL を消費させて割り込みを作る。
   */
  function racingService() {
    const base = makeService();
    let interleave: (() => Promise<void>) | undefined;
    const devices: typeof base.store.devices = Object.create(base.store.devices);
    const fire = async () => {
      const once = interleave;
      interleave = undefined;
      await once?.();
    };
    devices.getDevice = async (t, id) => {
      const snap = await base.store.devices.getDevice(t, id);
      await fire();
      return snap;
    };
    devices.findDeviceById = async (id) => {
      const snap = await base.store.devices.findDeviceById(id);
      await fire();
      return snap;
    };
    const svc = new DeviceService({
      devices,
      sites: base.store.sites,
      appendAudit: vi.fn(),
      now: () => NOW,
    });
    return {
      ...base,
      svc,
      /** 次に端末を読んだ直後に、保留中の URL（jti）を消費させる。消費が返した世代を受け取る。 */
      consumeOnNextRead(jti: string, issued: { generation?: number }) {
        interleave = async () => {
          const r = await base.svc.consumeEnrollment({
            tenantId: String(T_A),
            siteId: String(S_A1),
            deviceId: String(D_A1),
            jti,
          });
          if (!r.ok) throw new Error(`interleaved consume failed: ${r.reason}`);
          issued.generation = r.credentialGeneration;
        };
      },
    };
  }

  async function pendingJti(svc: DeviceService) {
    const r = await svc.issueEnrollment(developer, T_A, D_A1);
    if (!r.ok) throw new Error('issue failed');
    return extractJti(r.value.enrollment.token);
  }

  type Op = {
    name: string;
    run: (svc: DeviceService) => Promise<unknown>;
    expectedStatus: 'active' | 'revoked';
    flipsStatus: boolean;
  };
  const ops: Op[] = [
    {
      name: 'update（名称・設置場所）',
      run: (svc) => svc.update(tenantAdminA, T_A, D_A1, { name: '受付1改', location: '1F' }),
      expectedStatus: 'active',
      flipsStatus: false,
    },
    {
      name: 'issueEnrollment（URL の再発行）',
      run: (svc) => svc.issueEnrollment(developer, T_A, D_A1),
      expectedStatus: 'active',
      flipsStatus: false,
    },
    {
      name: 'setEnabled（状態が変わらない）',
      run: (svc) => svc.setEnabled(tenantAdminA, T_A, D_A1, true),
      expectedStatus: 'active',
      flipsStatus: false,
    },
    {
      name: 'setEnabled（失効）',
      run: (svc) => svc.setEnabled(tenantAdminA, T_A, D_A1, false),
      expectedStatus: 'revoked',
      flipsStatus: true,
    },
    {
      name: 'syncKioskState（失効）',
      run: (svc) =>
        svc.syncKioskState(
          { id: String(D_A1), displayName: '受付1', enabled: false },
          { tenantId: T_A, siteId: S_A1 },
        ),
      expectedStatus: 'revoked',
      flipsStatus: true,
    },
    {
      name: 'syncKioskState（状態が変わらない）',
      run: (svc) =>
        svc.syncKioskState(
          { id: String(D_A1), displayName: '受付1', enabled: true },
          { tenantId: T_A, siteId: S_A1 },
        ),
      expectedStatus: 'active',
      flipsStatus: false,
    },
  ];

  for (const op of ops) {
    for (const startGeneration of [undefined, 4] as const) {
      it(`🔴 ${op.name} / 開始時の世代 ${startGeneration ?? '未設定'}`, async () => {
        const r = racingService();
        if (startGeneration !== undefined) {
          await r.store.devices.putDevice(
            device({ id: D_A1, tenantId: T_A, siteId: S_A1, credentialGeneration: startGeneration }),
          );
        }
        const jti = await pendingJti(r.svc);
        const issued: { generation?: number } = {};
        r.consumeOnNextRead(jti, issued);

        await op.run(r.svc);

        // 下界: 割り込みが実際に起きている（起きていなければこのテストは空虚に通る）。
        expect(issued.generation).toBe((startGeneration ?? 0) + 1);
        const after = await r.store.devices.getDevice(T_A, D_A1);
        const generation = after?.credentialGeneration ?? 0;
        expect(generation).toBeGreaterThanOrEqual(issued.generation!);
        if (op.flipsStatus) expect(generation).toBeGreaterThan(issued.generation!);
        expect(after?.status).toBe(op.expectedStatus);
      });
    }
  }

  it('🔴 update の部分更新は、並行した失効を有効へ戻さない', async () => {
    const { store } = makeService();
    const admin = makeServiceFromStore(store);
    const devices: typeof store.devices = Object.create(store.devices);
    let fired = false;
    devices.getDevice = async (t, id) => {
      const snap = await store.devices.getDevice(t, id);
      if (!fired) {
        fired = true;
        await admin.setEnabled(tenantAdminA, T_A, D_A1, false);
      }
      return snap;
    };
    const svc = new DeviceService({ devices, sites: store.sites, appendAudit: vi.fn(), now: () => NOW });
    const res = await svc.update(tenantAdminA, T_A, D_A1, { name: '受付1改' });
    expect(res.ok).toBe(true);
    const after = await store.devices.getDevice(T_A, D_A1);
    expect(fired).toBe(true);
    expect(after?.status).toBe('revoked');
    expect(after?.credentialGeneration).toBe(1);
    expect(after?.name).toBe('受付1改');
  });

  it('🔴 状態切替の CAS に負け続けたら reject する（成功扱いにせず、device.disabled も残さない）', async () => {
    const { store } = makeService();
    const devices: typeof store.devices = Object.create(store.devices);
    let attempts = 0;
    // 毎回負ける CAS（読み直しのたびに別の書き込みが先行し続ける状況）。
    devices.changeDeviceStatus = async () => {
      attempts += 1;
      return false;
    };
    const audits: AuditAction[] = [];
    const svc = new DeviceService({
      devices,
      sites: store.sites,
      appendAudit: vi.fn(async (action) => {
        audits.push(action);
      }),
      now: () => NOW,
    });

    await expect(svc.setEnabled(tenantAdminA, T_A, D_A1, false)).rejects.toThrow();

    // 下界: CAS を実際に試みている（試みずに throw しても空虚に通らないように）。
    expect(attempts).toBeGreaterThan(1);
    expect(audits).toEqual([]);
    expect((await store.devices.getDevice(T_A, D_A1))?.status).toBe('active');
  });

  it('update は location を空にすると欄を消す（部分更新でも put と同じ意味）', async () => {
    const { svc, store } = makeService();
    await svc.update(tenantAdminA, T_A, D_A1, { location: '1F' });
    await svc.update(tenantAdminA, T_A, D_A1, { location: '  ' });
    const after = await store.devices.getDevice(T_A, D_A1);
    expect(after && 'location' in after).toBe(false);
  });

  it('update は割り込みで端末が消えていたら not_found（作り直さない）', async () => {
    const { store } = makeService();
    const devices: typeof store.devices = Object.create(store.devices);
    devices.getDevice = async (t, id) => {
      const snap = await store.devices.getDevice(t, id);
      await getBackend().collection<Device>(DEVICE_COLLECTION).remove(String(id));
      return snap;
    };
    const svc = new DeviceService({ devices, sites: store.sites, appendAudit: vi.fn(), now: () => NOW });
    const res = await svc.update(tenantAdminA, T_A, D_A1, { name: 'x' });
    expect(res).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await store.devices.getDevice(T_A, D_A1)).toBeUndefined();
  });
});

function makeServiceFromStore(store: ReturnType<typeof makeService>['store']) {
  return new DeviceService({
    devices: store.devices,
    sites: store.sites,
    appendAudit: vi.fn(),
    now: () => NOW,
  });
}
