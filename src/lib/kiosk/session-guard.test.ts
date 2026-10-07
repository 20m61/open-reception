/**
 * 共通 kiosk セッションガードの不変条件。
 *
 * 署名・有効期限が正しいトークンでも、端末台帳で有効と確かめられない限りセッションとして
 * 扱わない（fail-closed）。スコープは台帳からしか取らず、既定テナント/サイトへ写像しない。
 *
 * 台帳・旧レジストリ・受付は実物（memory backend）を使う。トークンも実署名で作るので
 * 有効期限は `Date.now()` 起点で、固定日付は持たない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asDeviceId, asSiteId, asTenantId, type Device } from '@/domain/tenant/types';
import { issueKioskSession } from '@/lib/auth/kiosk';
import { getTenantStore, __resetTenantStore } from '@/lib/tenant/store';
import { getKioskRepository, __resetKiosks } from '@/lib/kiosk/kiosk-store';
import {
  __resetStore,
  createReception,
  getReceptionSessionRepository,
} from '@/lib/data-stores/reception-store';
import { DEFAULT_SITE_ID, DEFAULT_TENANT_ID } from '@/lib/tenant/default-scope';
import { requireOwnedReception, resolveKioskSessionToken } from './session-guard';

let cookieValue: string | undefined;
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => (cookieValue === undefined ? undefined : { value: cookieValue }) }),
}));

const TENANT = 'TEST-tenant-guard';
const SITE = 'TEST-site-guard';

async function putDevice(id: string, status: Device['status'], tenant = TENANT, site = SITE) {
  const nowIso = new Date().toISOString();
  await getTenantStore().devices.putDevice({
    id: asDeviceId(id),
    tenantId: asTenantId(tenant),
    siteId: asSiteId(site),
    name: id,
    status,
    kind: 'kiosk',
    maintenance: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
}

beforeEach(async () => {
  await __resetTenantStore();
  await __resetKiosks();
  await __resetStore();
  cookieValue = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveKioskSessionToken', () => {
  it('有効な端末はスコープを台帳から取る（既定スコープではない）', async () => {
    await putDevice('TEST-active', 'active');
    const session = await resolveKioskSessionToken(await issueKioskSession('TEST-active'));
    expect(session).toEqual({ kioskId: 'TEST-active', tenantId: TENANT, siteId: SITE });
    // 下界の前提: fixture のスコープが既定と一致していたら、既定へ写像する実装と区別できない。
    expect(TENANT).not.toBe(DEFAULT_TENANT_ID);
    expect(SITE).not.toBe(DEFAULT_SITE_ID);
  });

  it('台帳で失効した端末の署名済みトークンは拒否する', async () => {
    await putDevice('TEST-revoked', 'revoked');
    expect(await resolveKioskSessionToken(await issueKioskSession('TEST-revoked'))).toBeNull();
  });

  it('台帳に居ない端末の署名済みトークンは拒否する（既定スコープへ写像しない）', async () => {
    expect(await resolveKioskSessionToken(await issueKioskSession('TEST-unknown'))).toBeNull();
  });

  it('台帳に居ない端末は、旧レジストリで有効でも拒否する（旧レジストリから既定スコープを補わない）', async () => {
    // 旧レジストリにだけ居る端末は heartbeat の取り込みで台帳へ載ってから通る。ここで旧レジストリの
    // enabled を根拠に通すと、スコープを台帳以外（既定テナント/サイト）から作ることになる。
    await getKioskRepository().putKiosk({ id: 'TEST-legacy-only', displayName: 'x', enabled: true });
    expect(await resolveKioskSessionToken(await issueKioskSession('TEST-legacy-only'))).toBeNull();
    cookieValue = await issueKioskSession('TEST-legacy-only');
    const owned = await requireOwnedReception('TEST-missing');
    expect(owned.ok).toBe(false);
    if (!owned.ok) expect(owned.response.status).toBe(403);
  });

  it('旧レジストリで無効化された端末は、台帳が active のままでも拒否する', async () => {
    await putDevice('TEST-legacy-off', 'active');
    await getKioskRepository().putKiosk({ id: 'TEST-legacy-off', displayName: 'x', enabled: false });
    expect(await resolveKioskSessionToken(await issueKioskSession('TEST-legacy-off'))).toBeNull();
  });

  it('旧レジストリで有効な端末は通る（旧レジストリの存在だけで拒否しない）', async () => {
    await putDevice('TEST-legacy-on', 'active');
    await getKioskRepository().putKiosk({ id: 'TEST-legacy-on', displayName: 'x', enabled: true });
    expect(await resolveKioskSessionToken(await issueKioskSession('TEST-legacy-on'))).not.toBeNull();
  });

  it('台帳が読めなければ拒否する', async () => {
    await putDevice('TEST-store-down', 'active');
    vi.spyOn(getTenantStore().devices, 'findDeviceById').mockRejectedValue(new Error('down'));
    expect(await resolveKioskSessionToken(await issueKioskSession('TEST-store-down'))).toBeNull();
  });

  it('旧レジストリが読めなければ拒否する', async () => {
    await putDevice('TEST-legacy-down', 'active');
    vi.spyOn(getKioskRepository(), 'getKiosk').mockRejectedValue(new Error('down'));
    expect(await resolveKioskSessionToken(await issueKioskSession('TEST-legacy-down'))).toBeNull();
  });

  it('署名が無効・トークン無しは拒否する', async () => {
    await putDevice('TEST-active', 'active');
    expect(await resolveKioskSessionToken(undefined)).toBeNull();
    expect(await resolveKioskSessionToken('not-a-token')).toBeNull();
  });
});

describe('requireOwnedReception', () => {
  async function receptionOf(kioskId: string): Promise<string> {
    const created = await createReception({
      kioskId,
      purpose: 'meeting',
      targetType: 'staff',
      targetId: 'TEST-staff',
      targetLabel: 'TEST',
      visitor: { name: 'TEST' },
    });
    if (!created.ok) throw new Error('fixture');
    return created.value.id;
  }

  it('作成端末のセッションなら受付とスコープを返す', async () => {
    await putDevice('TEST-owner', 'active');
    const id = await receptionOf('TEST-owner');
    cookieValue = await issueKioskSession('TEST-owner');
    const owned = await requireOwnedReception(id);
    expect(owned.ok).toBe(true);
    if (owned.ok) {
      expect(owned.reception.id).toBe(id);
      expect(owned.session).toEqual({ kioskId: 'TEST-owner', tenantId: TENANT, siteId: SITE });
    }
  });

  it('別端末の受付と存在しない受付は、どちらも同じ 404 を返す（存在を区別させない）', async () => {
    await putDevice('TEST-owner', 'active');
    await putDevice('TEST-other', 'active', 'TEST-tenant-other', 'TEST-site-other');
    const id = await receptionOf('TEST-owner');
    cookieValue = await issueKioskSession('TEST-other');
    const foreign = await requireOwnedReception(id);
    const missing = await requireOwnedReception('TEST-missing');
    expect(foreign.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (!foreign.ok && !missing.ok) {
      expect(foreign.response.status).toBe(404);
      expect(await foreign.response.json()).toEqual(await missing.response.json());
    }
  });

  it('セッションが無効なら、存在しない受付にも 403（受付の有無より先にセッションで止める）', async () => {
    const getReception = vi.spyOn(getReceptionSessionRepository(), 'get');
    await putDevice('TEST-revoked', 'revoked');
    for (const cookie of [undefined, 'not-a-token', await issueKioskSession('TEST-revoked')]) {
      cookieValue = cookie;
      const owned = await requireOwnedReception('TEST-missing');
      expect(owned.ok).toBe(false);
      if (!owned.ok) expect(owned.response.status).toBe(403);
    }
    expect(getReception).not.toHaveBeenCalled();
  });

  it('失効端末のセッションは自分の受付でも 403', async () => {
    await putDevice('TEST-owner', 'active');
    const id = await receptionOf('TEST-owner');
    await putDevice('TEST-owner', 'revoked');
    cookieValue = await issueKioskSession('TEST-owner');
    const owned = await requireOwnedReception(id);
    expect(owned.ok).toBe(false);
    if (!owned.ok) expect(owned.response.status).toBe(403);
  });
});
