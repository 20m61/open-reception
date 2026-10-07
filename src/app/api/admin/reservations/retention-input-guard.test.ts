/**
 * 保存期限が過去・計算不能になる入力を API の全書き込み経路で拒否する (#1022 M3 / N1 / N3)。
 *
 * 入力検証は `domain/reservation/lifecycle.ts` にあるが、UI だけでなく **API を直接叩いた場合**も
 * 同じく拒否されることをルートハンドラから縛る（作成 POST / 編集 PATCH / 再発行 POST token）。
 * 拒否された書き込みは何も残さない（一覧・単一取得で変化が無い）ことまで見る。
 *
 * 日付はすべて `Date.now()` 相対（固定日付は time bomb になる）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { asTenantId } from '@/domain/tenant/types';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
  resolveAdminActorWithIdentity: async () => {
    const actor = await resolveAdminActor();
    return actor ? { actor, identity: 'TEST-admin@example.com' } : null;
  },
  buildActorConfig: () => ({
    defaultTenantId: 'default',
    passwordRole: 'tenant_admin',
    developerEmails: new Set<string>(),
    entraUnregistered: 'deny',
  }),
}));
vi.mock('@/lib/data-stores/reception-log-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/data-stores/reception-log-store')>();
  return { ...actual, appendAdminAudit: vi.fn(async () => {}) };
});

import { GET as LIST_GET, POST as CREATE_POST } from './route';
import { GET as ITEM_GET, PATCH as ITEM_PATCH } from './[id]/route';
import { POST as TOKEN_POST } from './[id]/token/route';
import { __resetReservationService } from '@/lib/reservation/store';
import { getBackend } from '@/lib/data';
import { RESERVATION_COLLECTION } from '@/lib/reservation/data-backed-repository';

const TENANT = 'default';
const SITE = 'default-site';
const BASE = 'http://localhost/api/admin/reservations';
const DAY = 24 * 60 * 60 * 1000;
const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString();

function tenantAdmin(): Actor {
  return {
    status: 'active',
    assignments: [{ role: 'tenant_admin', tenantId: asTenantId(TENANT), siteId: null, deviceId: null }],
  };
}
function jsonReq(url: string, body: unknown, method = 'POST') {
  return new Request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
function params(id: string) {
  return { params: Promise.resolve({ id }) };
}
function createBody(over: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    siteId: SITE,
    visitorName: 'TEST-来客',
    visitAt: isoIn(1 * DAY),
    targetType: 'staff',
    targetId: 'staff-1',
    usagePolicy: 'single_use',
    expiresAt: isoIn(2 * DAY),
    retentionDays: 30,
    ...over,
  };
}
async function listIds(): Promise<string[]> {
  const res = await LIST_GET(new Request(`${BASE}?tenantId=${TENANT}&siteId=${SITE}`));
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }[]).map((r) => r.id);
}
async function getItem(id: string) {
  const res = await ITEM_GET(new Request(`${BASE}/${id}?tenantId=${TENANT}&siteId=${SITE}`), params(id));
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}
async function createOk(over: Record<string, unknown> = {}): Promise<string> {
  const res = await CREATE_POST(jsonReq(BASE, createBody(over)));
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** 保存期限（来訪の終わり + retentionDays）が過去・計算不能・TZ 曖昧になる入力。 */
const PAST_OR_UNCOMPUTABLE: [string, Record<string, unknown>][] = [
  ['期限が過去（visitAt/expiresAt + retentionDays < now）', { visitAt: isoIn(-10 * DAY), expiresAt: isoIn(-9 * DAY), retentionDays: 3 }],
  ['期限ちょうど過去（retentionDays 1・終わりが 1 日と 1 分前）', { visitAt: isoIn(-DAY - 60_000), expiresAt: isoIn(-DAY - 60_000), retentionDays: 1 }],
  ['retentionDays が巨大（積が非有限）', { retentionDays: 1e308 }],
  ['retentionDays が安全整数の外', { retentionDays: 2 ** 53 }],
  ['visitAt にオフセットが無い', { visitAt: '2099-06-20T10:00:00' }],
  ['expiresAt にオフセットが無い', { expiresAt: '2099-06-27T10:00' }],
];

beforeEach(async () => {
  vi.clearAllMocks();
  __resetReservationService();
  // 「何も保存しない」を一覧で見るので、テスト間で予約を持ち越さない。
  await getBackend()
    .collection<{ id: string; scopedTokenHash: string }>(RESERVATION_COLLECTION, { indexedField: 'scopedTokenHash' })
    .reset();
  resolveAdminActor.mockResolvedValue(tenantAdmin());
});

describe('予約 API — 保存期限が過去・計算不能になる書き込みを拒否する (#1022)', () => {
  it.each(PAST_OR_UNCOMPUTABLE)('POST 作成: %s → 400・何も保存しない', async (_label, over) => {
    const res = await CREATE_POST(jsonReq(BASE, createBody(over)));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe('invalid_input');
    expect(await listIds()).toEqual([]);
  });

  it('POST 作成: retentionDays・expiresAt 省略で既定（visitAt+7 日 + 30 日）の期限が過去 → 400', async () => {
    const body = createBody({ visitAt: isoIn(-38 * DAY - 60_000), expiresAt: undefined, retentionDays: undefined });
    const res = await CREATE_POST(jsonReq(BASE, body));
    expect(res.status).toBe(400);
    expect(await listIds()).toEqual([]);
  });

  it('POST 作成: 過去の来訪でも期限が未来なら受理する（下界・全拒否で空虚に通らない）', async () => {
    const id = await createOk({ visitAt: isoIn(-10 * DAY), expiresAt: isoIn(-9 * DAY), retentionDays: 30 });
    expect(await listIds()).toEqual([id]);
  });

  it.each(PAST_OR_UNCOMPUTABLE)('PATCH 編集: %s → 400・予約は変わらず残る', async (_label, over) => {
    const id = await createOk();
    const before = await getItem(id);
    const { tenantId: _t, siteId: _s, visitorName: _v, targetType: _tt, targetId: _ti, usagePolicy: _u, ...rest } =
      createBody(over);
    // パッチは期限に関わるフィールドだけ（visitAt / expiresAt / retentionDays）を送る。
    const patch = Object.fromEntries(Object.entries(rest).filter(([k]) => k in over || k === 'expiresAt'));
    const res = await ITEM_PATCH(jsonReq(`${BASE}/${id}`, { tenantId: TENANT, siteId: SITE, ...patch }, 'PATCH'), params(id));
    expect(res.status).toBe(400);
    expect(await getItem(id)).toEqual(before);
    expect(await listIds()).toEqual([id]);
  });

  // 「retentionDays だけを縮めて期限を過去にする」編集は API からは到達しない: 編集できるのは active
  // だけで、active なら expiresAt > now（期限切れは読み込み時に expired へ反映され 409）なので、
  // 期限 = max(visitAt, expiresAt) + retentionDays（≥ 1 日）は必ず未来に残る。純関数の側は
  // lifecycle.test.ts が直接縛る。

  it('PATCH 編集: 下界 — 期限が未来に残る編集は受理する', async () => {
    const id = await createOk();
    const res = await ITEM_PATCH(
      jsonReq(`${BASE}/${id}`, { tenantId: TENANT, siteId: SITE, retentionDays: 1, visitAt: isoIn(-DAY) }, 'PATCH'),
      params(id),
    );
    expect(res.status).toBe(200);
  });

  it('POST token 再発行: 新しい expiresAt で期限が過去になる → 400・期限も一覧も変わらない', async () => {
    // 期限は今 max(-40d, -5d) + 30d = +25d。新しい expiresAt を -39d にすると max(-40d, -39d) + 30d = -9d。
    const id = await createOk({ visitAt: isoIn(-40 * DAY), expiresAt: isoIn(-5 * DAY), retentionDays: 30 });
    const before = await getItem(id);
    for (const bad of [isoIn(-39 * DAY), '2099-06-27T10:00:00', 'not-a-date']) {
      const res = await TOKEN_POST(jsonReq(`${BASE}/${id}/token`, { tenantId: TENANT, siteId: SITE, expiresAt: bad }), params(id));
      expect(res.status, bad).toBe(400);
    }
    // 再発行前の読み込みが「期限切れ」を永続反映する（status / updatedAt は既存の挙動で変わる）ので、
    // 期限に関わるフィールドと一覧だけを比べる。
    const after = await getItem(id);
    expect(after.expiresAt).toBe(before.expiresAt);
    expect(after.visitAt).toBe(before.visitAt);
    expect(await listIds()).toEqual([id]);
    // 下界: 期限が未来に残る再発行は通る（-39d より 1 日以上遅い期限）。
    const ok = await TOKEN_POST(
      jsonReq(`${BASE}/${id}/token`, { tenantId: TENANT, siteId: SITE, expiresAt: isoIn(-9 * DAY) }),
      params(id),
    );
    expect(ok.status).toBe(200);
  });
});
