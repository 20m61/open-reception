/**
 * 予約 API 応答からの tokenHash 漏洩ガード (issue #375 I1 の回帰ネット)。
 *
 * #375 で生 token は保存せず一方向 hash（`tokenHash`）のみを永続化し、照合専用の内部値として
 * `VisitReservation` に載る。admin API はこれを `toReservationView` で落として応答するが、
 * この除去は**型強制ではない**ため、新しい予約エンドポイントを追加した際に view 変換を
 * 通し忘れると `tokenHash` が応答へ漏れる（第 14 wave 申し送り）。
 *
 * このガードは reservations 配下の全ルートハンドラを実際に呼び、成功/エラーいずれの
 * 応答 body にも `tokenHash` が現れないことを再帰的に検証する。ルートを増やしたら
 * 下の ROUTES 表に足すこと（`.claude/rules/pii-secret-minimization.md`）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { asTenantId } from '@/domain/tenant/types';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
  buildActorConfig: () => ({
    defaultTenantId: 'default',
    passwordRole: 'tenant_admin',
    developerEmails: new Set<string>(),
    entraUnregistered: 'deny',
  }),
}));
// 監査は no-op に差し替える（PII なし監査の内容は本テストの対象外）。
vi.mock('@/lib/data-stores/reception-log-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/data-stores/reception-log-store')>();
  return { ...actual, appendAdminAudit: vi.fn(async () => {}) };
});

import { GET as LIST_GET, POST as CREATE_POST } from './route';
import { GET as ITEM_GET, PATCH as ITEM_PATCH, DELETE as ITEM_DELETE } from './[id]/route';
import { POST as REVOKE_POST } from './[id]/revoke/route';
import { POST as TOKEN_POST } from './[id]/token/route';
import { GET as QR_GET } from './[id]/qr/route';
import { __resetReservationService } from '@/lib/reservation/store';

const TENANT = 'default';
const SITE = 'default-site';

function tenantAdmin(): Actor {
  return {
    status: 'active',
    assignments: [{ role: 'tenant_admin', tenantId: asTenantId(TENANT), siteId: null, deviceId: null }],
  };
}

/** body（配列/オブジェクトを含む）に `tokenHash` キーが 1 つも無いことを再帰確認する。 */
function assertNoTokenHash(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoTokenHash(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      expect(k, `tokenHash leaked at ${path}.${k}`).not.toBe('tokenHash');
      assertNoTokenHash(v, `${path}.${k}`);
    }
  }
}

function jsonReq(url: string, body: unknown, method = 'POST') {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

const BASE = 'http://localhost/api/admin/reservations';
const CREATE_BODY = {
  tenantId: TENANT,
  siteId: SITE,
  visitorName: '山田太郎',
  visitAt: '2099-06-20T01:00:00.000Z',
  targetType: 'staff',
  targetId: 'staff-1',
  usagePolicy: 'single_use',
  expiresAt: '2099-06-27T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetReservationService();
  resolveAdminActor.mockResolvedValue(tenantAdmin());
});

/** 有効な予約を 1 件作成し、その id を返す（作成応答自体もガード対象にする）。 */
async function createReservation(): Promise<string> {
  const res = await CREATE_POST(jsonReq(BASE, CREATE_BODY));
  expect(res.status, 'create should succeed for authorized admin').toBe(201);
  const body = await res.json();
  assertNoTokenHash(body, 'create');
  return (body as { id: string }).id;
}

describe('予約 API — 応答に tokenHash を漏らさない (#375 I1 回帰ガード)', () => {
  it('POST /reservations（作成・一度きり token 応答）に tokenHash が無い', async () => {
    await createReservation();
  });

  it('GET /reservations（一覧）に tokenHash が無い', async () => {
    await createReservation();
    const res = await LIST_GET(new Request(`${BASE}?tenantId=${TENANT}&siteId=${SITE}`));
    expect(res.status).toBe(200);
    assertNoTokenHash(await res.json(), 'list');
  });

  it('GET /reservations/:id（単一取得）に tokenHash が無い', async () => {
    const id = await createReservation();
    const res = await ITEM_GET(new Request(`${BASE}/${id}?tenantId=${TENANT}&siteId=${SITE}`), params(id));
    expect(res.status).toBe(200);
    assertNoTokenHash(await res.json(), 'get');
  });

  it('PATCH /reservations/:id（編集）に tokenHash が無い', async () => {
    const id = await createReservation();
    const res = await ITEM_PATCH(
      jsonReq(`${BASE}/${id}`, { tenantId: TENANT, siteId: SITE, note: '更新' }, 'PATCH'),
      params(id),
    );
    expect(res.status).toBe(200);
    assertNoTokenHash(await res.json(), 'edit');
  });

  it('POST /reservations/:id/token（再発行・一度きり token 応答）に tokenHash が無い', async () => {
    const id = await createReservation();
    const res = await TOKEN_POST(jsonReq(`${BASE}/${id}/token`, { tenantId: TENANT, siteId: SITE }), params(id));
    expect(res.status).toBe(200);
    assertNoTokenHash(await res.json(), 'reissueToken');
  });

  it('POST /reservations/:id/revoke（失効）に tokenHash が無い', async () => {
    const id = await createReservation();
    const res = await REVOKE_POST(jsonReq(`${BASE}/${id}/revoke`, { tenantId: TENANT, siteId: SITE }), params(id));
    expect(res.status).toBe(200);
    assertNoTokenHash(await res.json(), 'revoke');
  });

  it('DELETE /reservations/:id（キャンセル）に tokenHash が無い', async () => {
    const id = await createReservation();
    const res = await ITEM_DELETE(new Request(`${BASE}/${id}?tenantId=${TENANT}&siteId=${SITE}`, { method: 'DELETE' }), params(id));
    expect(res.status).toBe(200);
    assertNoTokenHash(await res.json(), 'cancel');
  });

  it('GET /reservations/:id/qr（再取得不可・410）に tokenHash が無い', async () => {
    const id = await createReservation();
    const res = await QR_GET(new Request(`${BASE}/${id}/qr?tenantId=${TENANT}&siteId=${SITE}`), params(id));
    expect(res.status).toBe(410);
    assertNoTokenHash(await res.json(), 'qr');
  });
});
