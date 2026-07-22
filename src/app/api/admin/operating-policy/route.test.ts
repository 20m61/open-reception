/**
 * /api/admin/operating-policy のテスト (issue #367)。
 *
 * 認可の実判定（canAccessSite の viewer/越境挙動）は `src/domain/tenant/authorization.ts` の
 * 純関数テストに委ねる（`rules/testing.md`）。ここでは「ガードを通す/通さないで 200/403/401/400 に
 * なること」と、検証エラー（逆転区間等）が 400+issues で返ることだけを検証する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireActor = vi.fn();
const assertCanReadSite = vi.fn();
const assertCanWriteSite = vi.fn();
const requireActorWithIdentity = vi.fn();
const getOperatingPolicy = vi.fn();
const upsertOperatingPolicy = vi.fn();

class FakeGuardError extends Error {
  status: 401 | 403;
  code: 'unauthorized' | 'forbidden';
  constructor(status: 401 | 403, code: 'unauthorized' | 'forbidden') {
    super(code);
    this.status = status;
    this.code = code;
  }
}

vi.mock('@/lib/admin/guard', () => ({
  requireActor: (...a: unknown[]) => requireActor(...a),
  assertCanReadSite: (...a: unknown[]) => assertCanReadSite(...a),
  assertCanWriteSite: (...a: unknown[]) => assertCanWriteSite(...a),
  toGuardResponse: (err: unknown) => {
    if (err instanceof FakeGuardError) {
      return new Response(JSON.stringify({ error: err.code }), { status: err.status });
    }
    throw err;
  },
}));

vi.mock('@/lib/operating-policy/request', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/operating-policy/request')>();
  return { ...actual, requireActorWithIdentity: (...a: unknown[]) => requireActorWithIdentity(...a) };
});

vi.mock('@/lib/operating-policy/store', () => ({
  getOperatingPolicy: (...a: unknown[]) => getOperatingPolicy(...a),
  upsertOperatingPolicy: (...a: unknown[]) => upsertOperatingPolicy(...a),
}));

import { GET, PUT } from './route';

function getReq(qs: string): Request {
  return new Request(`http://localhost/api/admin/operating-policy${qs}`);
}
function putReq(body: unknown): Request {
  return new Request('http://localhost/api/admin/operating-policy', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ACTOR = { status: 'active', assignments: [] };

beforeEach(() => {
  vi.clearAllMocks();
  requireActor.mockResolvedValue(ACTOR);
  requireActorWithIdentity.mockResolvedValue({ actor: ACTOR, identity: 'admin@example.com' });
  assertCanReadSite.mockReturnValue(undefined);
  assertCanWriteSite.mockReturnValue(undefined);
});

describe('GET /api/admin/operating-policy', () => {
  it('tenantId/siteId 未指定は 400', async () => {
    const res = await GET(getReq(''));
    expect(res.status).toBe(400);
  });

  it('ガードを通れば policy を返す（未設定は null）', async () => {
    getOperatingPolicy.mockResolvedValue(null);
    const res = await GET(getReq('?tenantId=t1&siteId=s1'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ policy: null });
    expect(assertCanReadSite).toHaveBeenCalledWith(ACTOR, 't1', 's1');
  });

  it('未認証（401）はガードを通さない', async () => {
    requireActor.mockRejectedValue(new FakeGuardError(401, 'unauthorized'));
    const res = await GET(getReq('?tenantId=t1&siteId=s1'));
    expect(res.status).toBe(401);
    expect(getOperatingPolicy).not.toHaveBeenCalled();
  });

  it('viewer 越境等で assertCanReadSite が拒否すれば 403', async () => {
    assertCanReadSite.mockImplementation(() => {
      throw new FakeGuardError(403, 'forbidden');
    });
    const res = await GET(getReq('?tenantId=t1&siteId=s1'));
    expect(res.status).toBe(403);
    expect(getOperatingPolicy).not.toHaveBeenCalled();
  });
});

describe('PUT /api/admin/operating-policy', () => {
  it('tenantId/siteId 未指定は 400', async () => {
    const res = await PUT(putReq({}));
    expect(res.status).toBe(400);
    expect(upsertOperatingPolicy).not.toHaveBeenCalled();
  });

  it('viewer は書込不可（403）', async () => {
    assertCanWriteSite.mockImplementation(() => {
      throw new FakeGuardError(403, 'forbidden');
    });
    const res = await PUT(putReq({ tenantId: 't1', siteId: 's1', weeklySchedule: {} }));
    expect(res.status).toBe(403);
    expect(upsertOperatingPolicy).not.toHaveBeenCalled();
  });

  it('検証エラー（逆転区間等）は 400 + issues を返す', async () => {
    upsertOperatingPolicy.mockResolvedValue({
      ok: false,
      error: { code: 'invalid_input', message: 'operating policy is invalid', issues: [{ field: 'weeklySchedule.mon[0]', message: 'end must be after start' }] },
    });
    const res = await PUT(putReq({ tenantId: 't1', siteId: 's1', weeklySchedule: { mon: [{ start: '18:00', end: '09:00' }] } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues).toHaveLength(1);
  });

  it('成功時は identity を updatedBy として service に渡し、更新後ポリシーを返す', async () => {
    const saved = { tenantId: 't1', siteId: 's1', timezone: 'Asia/Tokyo', weeklySchedule: {}, fixedHolidays: [], exceptionDates: [], version: 1, updatedAt: '2026-07-22T00:00:00.000Z', updatedBy: 'admin@example.com' };
    upsertOperatingPolicy.mockResolvedValue({ ok: true, value: saved });
    const res = await PUT(putReq({ tenantId: 't1', siteId: 's1', weeklySchedule: {} }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ policy: saved });
    expect(upsertOperatingPolicy).toHaveBeenCalledWith('t1', 's1', 'admin@example.com', expect.objectContaining({ tenantId: 't1', siteId: 's1' }));
  });

  it('未認証は 401 で service を呼ばない', async () => {
    requireActorWithIdentity.mockRejectedValue(new FakeGuardError(401, 'unauthorized'));
    const res = await PUT(putReq({ tenantId: 't1', siteId: 's1' }));
    expect(res.status).toBe(401);
    expect(upsertOperatingPolicy).not.toHaveBeenCalled();
  });
});
