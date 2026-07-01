/**
 * POST /api/platform/elevate と assertElevated の認可・昇格ゲート (issue #83 AC5/AC10 inc4b)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { grantElevation } from '@/domain/auth/elevation';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const cookieGet = vi.fn<(name: string) => { value: string } | undefined>();

const resolveAdminActorWithIdentity = vi.fn<() => Promise<{ actor: Actor; identity: string } | null>>();
vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
  resolveAdminActorWithIdentity: () => resolveAdminActorWithIdentity(),
}));
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve({ get: (n: string) => cookieGet(n) }) }));
// 監査は副作用なので no-op 化（appendAdminAudit の実書込みを避ける）。
vi.mock('@/lib/admin/audit', () => ({ recordDangerAction: vi.fn().mockResolvedValue(undefined) }));

import { POST as ELEVATE } from './route';
import { POST as ELEVATE_END } from './end/route';
import { assertElevated } from '@/lib/platform/request';
import { issueElevationToken, ELEVATION_COOKIE } from '@/lib/platform/elevation';
import { revokeElevationJti, __resetElevationJtis } from '@/lib/platform/elevation-jti-store';

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
beforeEach(async () => {
  vi.clearAllMocks();
  cookieGet.mockReturnValue(undefined);
  await __resetElevationJtis();
});
afterEach(() => {
  if (prevMock === undefined) delete process.env.PLATFORM_REAUTH_MOCK;
  else process.env.PLATFORM_REAUTH_MOCK = prevMock;
});

describe('POST /api/platform/elevate', () => {
  const asDeveloper = () => resolveAdminActorWithIdentity.mockResolvedValue({ actor: developer(), identity: 'dev@example.com' });

  it('未認証は 401', async () => {
    resolveAdminActorWithIdentity.mockResolvedValue(null);
    expect((await ELEVATE(req({ reason: 'x', credential: 'x' }))).status).toBe(401);
  });

  it('非 developer は 403', async () => {
    resolveAdminActorWithIdentity.mockResolvedValue({ actor: tenantAdmin(), identity: 'ta@example.com' });
    expect((await ELEVATE(req({ reason: 'x', credential: 'x' }))).status).toBe(403);
  });

  it('reason 空は 400', async () => {
    asDeveloper();
    expect((await ELEVATE(req({ reason: '  ', credential: 'x' }))).status).toBe(400);
  });

  it('mock 未設定（再認証不可）は 403 reauth_failed', async () => {
    delete process.env.PLATFORM_REAUTH_MOCK;
    asDeveloper();
    const res = await ELEVATE(req({ reason: '設定変更', credential: 'x' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('reauth_failed');
  });

  it('再認証成功で 200 + platform_elevation cookie', async () => {
    process.env.PLATFORM_REAUTH_MOCK = 'otp-123';
    asDeveloper();
    const res = await ELEVATE(req({ reason: '障害調査', provider: 'none', credential: 'otp-123' }));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${ELEVATION_COOKIE}=`);
    expect(setCookie.toLowerCase()).toContain('httponly');
  });
});

describe('assertElevated', () => {
  const asSelf = () => resolveAdminActorWithIdentity.mockResolvedValue({ actor: developer(), identity: 'dev@example.com' });

  it('developer でも未昇格は 403 elevation_required', async () => {
    asSelf();
    cookieGet.mockReturnValue(undefined);
    const r = await assertElevated();
    expect(r.ok).toBe(false);
    if (!r.ok) expect((await r.response.json()).error).toBe('elevation_required');
  });

  it('有効な昇格 cookie（本人）は ok（actor + elevation を返す）', async () => {
    asSelf();
    const token = await issueElevationToken(grantElevation({ reason: '調査', scope: {} }, Date.now()), 'j', 'dev@example.com');
    cookieGet.mockImplementation((n) => (n === ELEVATION_COOKIE ? { value: token } : undefined));
    const r = await assertElevated();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.elevation.reason).toBe('調査');
  });

  it('別 developer の昇格 cookie（sub 不一致）は 403（replay/誤帰属防止, #264）', async () => {
    asSelf(); // 現在の操作者は dev@example.com。
    // cookie は other@example.com が発行した昇格。
    const token = await issueElevationToken(grantElevation({ reason: 'x', scope: {} }, Date.now()), 'j', 'other@example.com');
    cookieGet.mockImplementation((n) => (n === ELEVATION_COOKIE ? { value: token } : undefined));
    const r = await assertElevated();
    expect(r.ok).toBe(false);
  });

  it('スコープ外の昇格は 403（platform 全体でない昇格で tenant 限定操作を要求）', async () => {
    asSelf();
    // tenant t1 のみの昇格 cookie で、tenant t2 を対象に要求 → out_of_scope。
    const token = await issueElevationToken(grantElevation({ reason: 'x', scope: { tenantId: 't1' } }, Date.now()), 'j', 'dev@example.com');
    cookieGet.mockImplementation((n) => (n === ELEVATION_COOKIE ? { value: token } : undefined));
    const r = await assertElevated({ tenantId: 't2' });
    expect(r.ok).toBe(false);
  });

  it('失効済み jti の cookie は 403 revoked（期限内でも end 後は replay 不可, #264）', async () => {
    asSelf();
    const token = await issueElevationToken(grantElevation({ reason: 'x', scope: {} }, Date.now()), 'j-revoked', 'dev@example.com');
    cookieGet.mockImplementation((n) => (n === ELEVATION_COOKIE ? { value: token } : undefined));
    await revokeElevationJti('j-revoked', Date.now());
    const r = await assertElevated();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(403);
      expect(await r.response.json()).toEqual({ error: 'elevation_required', reason: 'revoked' });
    }
  });

  it('ストアに記録の無い jti は 403（fail-closed: 署名が正しくても発行記録が無ければ無効, #264）', async () => {
    asSelf();
    const token = await issueElevationToken(grantElevation({ reason: 'x', scope: {} }, Date.now()), 'j-unknown', 'dev@example.com');
    cookieGet.mockImplementation((n) => (n === ELEVATION_COOKIE ? { value: token } : undefined));
    await __resetElevationJtis(); // 発行記録を消す = 鍵漏洩などで offline 生成された cookie を模す。
    const r = await assertElevated();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(403);
  });
});

describe('POST /api/platform/elevate/end (#264)', () => {
  const asSelf = () => resolveAdminActorWithIdentity.mockResolvedValue({ actor: developer(), identity: 'dev@example.com' });
  const endReq = () => new Request('http://t/api/platform/elevate/end', { method: 'POST' });

  it('未認証は 401', async () => {
    resolveAdminActorWithIdentity.mockResolvedValue(null);
    expect((await ELEVATE_END(endReq())).status).toBe(401);
  });

  it('非 developer は 403', async () => {
    resolveAdminActorWithIdentity.mockResolvedValue({ actor: tenantAdmin(), identity: 'ta@example.com' });
    expect((await ELEVATE_END(endReq())).status).toBe(403);
  });

  it('本人の昇格を end すると jti が失効し、以降の assertElevated は 403', async () => {
    asSelf();
    const token = await issueElevationToken(grantElevation({ reason: '調査', scope: {} }, Date.now()), 'j-end', 'dev@example.com');
    cookieGet.mockImplementation((n) => (n === ELEVATION_COOKIE ? { value: token } : undefined));
    expect((await assertElevated()).ok).toBe(true); // end 前は有効。

    const res = await ELEVATE_END(endReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ended: true });
    // cookie も即時削除する（失効はサーバ側 jti で強制済み。削除は UX）。
    expect((res.headers.get('set-cookie') ?? '').toLowerCase()).toContain('platform_elevation=;');

    expect((await assertElevated()).ok).toBe(false); // cookie が残っていても jti 失効で拒否。
  });

  it('昇格 cookie なしでも 200（冪等: ended:false で何も失効しない）', async () => {
    asSelf();
    cookieGet.mockReturnValue(undefined);
    const res = await ELEVATE_END(endReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ended: false });
  });

  it('別人の昇格 cookie は end しない（ended:false。他人の jti を横取り失効させない）', async () => {
    asSelf();
    const token = await issueElevationToken(grantElevation({ reason: 'x', scope: {} }, Date.now()), 'j-other', 'other@example.com');
    cookieGet.mockImplementation((n) => (n === ELEVATION_COOKIE ? { value: token } : undefined));
    const res = await ELEVATE_END(endReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ended: false });
  });
});
