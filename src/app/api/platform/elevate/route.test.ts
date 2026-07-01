/**
 * POST /api/platform/elevate と assertElevated の認可・昇格ゲート (issue #83 AC5/AC10 inc4b)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { grantElevation } from '@/domain/auth/elevation';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const cookieGet = vi.fn<(name: string) => { value: string } | undefined>();

vi.mock('@/lib/auth/actor', () => ({ resolveAdminActor: () => resolveAdminActor() }));
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve({ get: (n: string) => cookieGet(n) }) }));
// 監査は副作用なので no-op 化（appendAdminAudit の実書込みを避ける）。
vi.mock('@/lib/admin/audit', () => ({ recordDangerAction: vi.fn().mockResolvedValue(undefined) }));

import { POST as ELEVATE } from './route';
import { assertElevated } from '@/lib/platform/request';
import { issueElevationToken, ELEVATION_COOKIE } from '@/lib/platform/elevation';

function developer(): Actor {
  return { status: 'active', assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }] };
}
function tenantAdmin(): Actor {
  return { status: 'active', assignments: [{ role: 'tenant_admin', tenantId: null as never, siteId: null, deviceId: null }] };
}
function req(body: unknown): Request {
  return new Request('http://t/api/platform/elevate', { method: 'POST', body: JSON.stringify(body) });
}

const prevMock = process.env.PLATFORM_REAUTH_MOCK;
beforeEach(() => {
  vi.clearAllMocks();
  cookieGet.mockReturnValue(undefined);
});
afterEach(() => {
  if (prevMock === undefined) delete process.env.PLATFORM_REAUTH_MOCK;
  else process.env.PLATFORM_REAUTH_MOCK = prevMock;
});

describe('POST /api/platform/elevate', () => {
  it('未認証は 401', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await ELEVATE(req({ reason: 'x', credential: 'x' }))).status).toBe(401);
  });

  it('非 developer は 403', async () => {
    resolveAdminActor.mockResolvedValue(tenantAdmin());
    expect((await ELEVATE(req({ reason: 'x', credential: 'x' }))).status).toBe(403);
  });

  it('reason 空は 400', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    expect((await ELEVATE(req({ reason: '  ', credential: 'x' }))).status).toBe(400);
  });

  it('mock 未設定（再認証不可）は 403 reauth_failed', async () => {
    delete process.env.PLATFORM_REAUTH_MOCK;
    resolveAdminActor.mockResolvedValue(developer());
    const res = await ELEVATE(req({ reason: '設定変更', credential: 'x' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('reauth_failed');
  });

  it('再認証成功で 200 + platform_elevation cookie', async () => {
    process.env.PLATFORM_REAUTH_MOCK = 'otp-123';
    resolveAdminActor.mockResolvedValue(developer());
    const res = await ELEVATE(req({ reason: '障害調査', provider: 'none', credential: 'otp-123' }));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${ELEVATION_COOKIE}=`);
    expect(setCookie.toLowerCase()).toContain('httponly');
  });
});

describe('assertElevated', () => {
  it('developer でも未昇格は 403 elevation_required', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    cookieGet.mockReturnValue(undefined);
    const r = await assertElevated();
    expect(r.ok).toBe(false);
    if (!r.ok) expect((await r.response.json()).error).toBe('elevation_required');
  });

  it('有効な昇格 cookie があれば ok（actor + elevation を返す）', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    const token = await issueElevationToken(grantElevation({ reason: '調査', scope: {} }, Date.now()), 'j');
    cookieGet.mockImplementation((n) => (n === ELEVATION_COOKIE ? { value: token } : undefined));
    const r = await assertElevated();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.elevation.reason).toBe('調査');
  });

  it('スコープ外の昇格は 403（platform 全体でない昇格で tenant 限定操作を要求）', async () => {
    resolveAdminActor.mockResolvedValue(developer());
    // tenant t1 のみの昇格 cookie で、tenant t2 を対象に要求 → out_of_scope。
    const token = await issueElevationToken(grantElevation({ reason: 'x', scope: { tenantId: 't1' } }, Date.now()), 'j');
    cookieGet.mockImplementation((n) => (n === ELEVATION_COOKIE ? { value: token } : undefined));
    const r = await assertElevated({ tenantId: 't2' });
    expect(r.ok).toBe(false);
  });
});
