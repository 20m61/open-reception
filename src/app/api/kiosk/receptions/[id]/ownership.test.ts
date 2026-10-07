/**
 * 受付 `[id]` の状態遷移 route は、その受付を作成した端末のセッションでしか動かない。
 *
 * route は `receptions/[id]` 配下をファイルシステムから棚卸しし、各 route を
 * 「状態遷移（本ファイルが縛る）」か「その他（既存テストが縛る）」のどちらかへ**必ず**分類させる
 * （足した route が黙って対象外になるのを防ぐ）。
 *
 * 不変条件（状態遷移 route 全部 × 他端末セッション全部）:
 *   - 他端末（別テナント / 同テナント別拠点 / 同拠点別端末）のセッションは 404 で、本文は
 *     存在しない受付への要求と同一（存在を区別させない）。受付は 1 バイトも変わらず、
 *     取次の判定・通話の切断にも到達しない。
 *   - 下界: 作成端末のセッションなら遷移が成功し（2xx・状態が変わる）、取次判定・切断には
 *     **セッションのテナント/拠点**が渡る（既定スコープではない）。
 *
 * 端末・受付は実ストア（memory backend）、トークンは実署名（有効期限は `Date.now()` 起点）。
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asDeviceId, asSiteId, asTenantId } from '@/domain/tenant/types';
import type { ReceptionState } from '@/domain/reception/state';
import { issueKioskSession } from '@/lib/auth/kiosk';
import { getTenantStore, __resetTenantStore } from '@/lib/tenant/store';
import { __resetKiosks } from '@/lib/kiosk/kiosk-store';
import {
  __resetStore,
  createReception,
  getReception,
  getReceptionSessionRepository,
} from '@/lib/data-stores/reception-store';
import { DEFAULT_SITE_ID, DEFAULT_TENANT_ID } from '@/lib/tenant/default-scope';

let cookieValue: string | undefined;
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'kiosk_session' && cookieValue !== undefined ? { value: cookieValue } : undefined,
  }),
  headers: async () => new Headers(),
}));

const evaluateCallGuard = vi.fn();
vi.mock('@/lib/operating-policy/call-guard', () => ({
  evaluateCallGuard: (...a: unknown[]) => evaluateCallGuard(...a),
}));
const hangUpIfRinging = vi.fn();
vi.mock('@/lib/routing/hang-up', () => ({
  hangUpIfRinging: (...a: unknown[]) => hangUpIfRinging(...a),
}));

/** 状態遷移 route と、作成端末が遷移に成功できる開始状態。 */
const TRANSITIONS: Record<string, ReceptionState> = {
  call: 'confirming',
  cancel: 'calling',
  complete: 'connected',
  connected: 'calling',
  fallback: 'timeout',
  'give-up': 'calling',
  timeout: 'calling',
};
/** 状態遷移ではない route（所有権は各 route の既存テストが縛る）。 */
const NON_TRANSITIONS = new Set(['feedback', 'status', 'token']);

const ID_ROOT = __dirname;
const ROUTES = readdirSync(ID_ROOT)
  .filter((name) => statSync(path.join(ID_ROOT, name)).isDirectory())
  .filter((name) => {
    try {
      return statSync(path.join(ID_ROOT, name, 'route.ts')).isFile();
    } catch {
      return false;
    }
  })
  .sort();

const OWNER = { kioskId: 'TEST-owner', tenantId: 'TEST-tenant-a', siteId: 'TEST-site-a1' };
const FOREIGN = [
  { label: '別テナント', kioskId: 'TEST-tenant-b-kiosk', tenantId: 'TEST-tenant-b', siteId: 'TEST-site-b1' },
  { label: '同テナント別拠点', kioskId: 'TEST-site-a2-kiosk', tenantId: 'TEST-tenant-a', siteId: 'TEST-site-a2' },
  { label: '同拠点別端末', kioskId: 'TEST-site-a1-other', tenantId: 'TEST-tenant-a', siteId: 'TEST-site-a1' },
];

async function putDevice(d: { kioskId: string; tenantId: string; siteId: string }) {
  const nowIso = new Date().toISOString();
  await getTenantStore().devices.putDevice({
    id: asDeviceId(d.kioskId),
    tenantId: asTenantId(d.tenantId),
    siteId: asSiteId(d.siteId),
    name: d.kioskId,
    status: 'active',
    kind: 'kiosk',
    maintenance: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
}

async function ownedReception(state: ReceptionState): Promise<string> {
  const created = await createReception({
    kioskId: OWNER.kioskId,
    purpose: 'meeting',
    targetType: 'staff',
    targetId: 'TEST-staff',
    targetLabel: 'TEST',
    visitor: { name: 'TEST' },
  });
  if (!created.ok) throw new Error('fixture');
  await getReceptionSessionRepository().put({ ...created.value, state, providerCallId: 'TEST-call' });
  return created.value.id;
}

async function post(route: string, id: string): Promise<Response> {
  const mod = (await import(`./${route}/route`)) as {
    POST: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  };
  return mod.POST(new Request(`http://localhost/api/kiosk/receptions/${id}/${route}`, { method: 'POST' }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  evaluateCallGuard.mockResolvedValue({ allowed: true });
  hangUpIfRinging.mockResolvedValue({ kind: 'terminated' });
  await __resetTenantStore();
  await __resetKiosks();
  await __resetStore();
  cookieValue = undefined;
  for (const d of [OWNER, ...FOREIGN]) await putDevice(d);
});

describe('receptions/[id] の棚卸し', () => {
  it('全 route がどちらかへ分類されている', () => {
    for (const r of ROUTES) {
      expect(r in TRANSITIONS || NON_TRANSITIONS.has(r), `未分類の route: ${r}`).toBe(true);
    }
    for (const r of Object.keys(TRANSITIONS)) expect(ROUTES).toContain(r);
  });

  it('fixture のスコープは既定スコープと異なる（既定へ倒す実装と区別するため）', () => {
    expect(OWNER.tenantId).not.toBe(DEFAULT_TENANT_ID);
    expect(OWNER.siteId).not.toBe(DEFAULT_SITE_ID);
  });
});

describe.each(Object.entries(TRANSITIONS))('POST receptions/[id]/%s', (route, startState) => {
  it.each(FOREIGN)('$label のセッションでは 404・受付不変・副作用なし', async (foreign) => {
    const id = await ownedReception(startState);
    const before = await getReception(id);
    cookieValue = await issueKioskSession(foreign.kioskId);

    const res = await post(route, id);
    const missing = await post(route, 'TEST-missing-reception');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(await missing.json());
    expect(await getReception(id)).toEqual(before);
    expect(evaluateCallGuard).not.toHaveBeenCalled();
    expect(hangUpIfRinging).not.toHaveBeenCalled();
  });

  it('作成端末のセッションなら遷移し、セッションのスコープで判定・切断する', async () => {
    const id = await ownedReception(startState);
    cookieValue = await issueKioskSession(OWNER.kioskId);

    const res = await post(route, id);

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    const after = await getReception(id);
    expect(after.ok && after.value.state).not.toBe(startState);
    for (const [tenantId, siteId] of evaluateCallGuard.mock.calls) {
      expect([tenantId, siteId]).toEqual([OWNER.tenantId, OWNER.siteId]);
    }
    for (const [tenantId] of hangUpIfRinging.mock.calls) expect(tenantId).toBe(OWNER.tenantId);
    if (route === 'call') expect(evaluateCallGuard).toHaveBeenCalled();
    if (route === 'cancel' || route === 'give-up') expect(hangUpIfRinging).toHaveBeenCalled();
  });
});
