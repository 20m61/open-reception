/**
 * POST /api/platform/elevate/break-glass — break-glass 緊急昇格の発行 (issue #83 §3)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import { BREAK_GLASS_TTL_MS } from '@/domain/auth/elevation';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const resolveAdminActorWithIdentity = vi.fn<() => Promise<{ actor: Actor; identity: string } | null>>();
const cookieGet = vi.fn<(name: string) => { value: string } | undefined>();
const recordDangerAction = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
  resolveAdminActorWithIdentity: () => resolveAdminActorWithIdentity(),
}));
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve({ get: (n: string) => cookieGet(n) }) }));
vi.mock('@/lib/admin/audit', () => ({
  recordDangerAction: (...args: unknown[]) => recordDangerAction(...args),
}));

import { POST } from './route';
import { POST as ELEVATE_END } from '../end/route';
import { assertElevated } from '@/lib/platform/request';
import { ELEVATION_COOKIE, readElevation } from '@/lib/platform/elevation';
import { __resetElevationJtis } from '@/lib/platform/elevation-jti-store';

function developer(): Actor {
  return { status: 'active', assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }] };
}
function tenantAdmin(): Actor {
  return { status: 'active', assignments: [{ role: 'tenant_admin', tenantId: null as never, siteId: null, deviceId: null }] };
}
function req(body: unknown): Request {
  return new Request('http://t/api/platform/elevate/break-glass', { method: 'POST', body: JSON.stringify(body) });
}
const valid = { reason: '本番障害の緊急対応', provider: 'none', credential: 'otp-123', acknowledge: true };

const prevMock = process.env.PLATFORM_REAUTH_MOCK;
beforeEach(async () => {
  vi.clearAllMocks();
  cookieGet.mockReturnValue(undefined);
  process.env.PLATFORM_REAUTH_MOCK = 'otp-123';
  await __resetElevationJtis();
});
afterEach(() => {
  if (prevMock === undefined) delete process.env.PLATFORM_REAUTH_MOCK;
  else process.env.PLATFORM_REAUTH_MOCK = prevMock;
});

describe('POST /api/platform/elevate/break-glass (#83 §3)', () => {
  const asDeveloper = () =>
    resolveAdminActorWithIdentity.mockResolvedValue({ actor: developer(), identity: 'dev@example.com' });

  it('未認証は 401', async () => {
    resolveAdminActorWithIdentity.mockResolvedValue(null);
    expect((await POST(req(valid))).status).toBe(401);
  });

  it('非 developer は 403', async () => {
    resolveAdminActorWithIdentity.mockResolvedValue({ actor: tenantAdmin(), identity: 'ta@example.com' });
    expect((await POST(req(valid))).status).toBe(403);
  });

  it('reason 空は 400 reason_required（利用理由必須）', async () => {
    asDeveloper();
    const res = await POST(req({ ...valid, reason: '  ' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('reason_required');
  });

  it('acknowledge 無しは 400 acknowledge_required（明示的な解錠ステップ）', async () => {
    asDeveloper();
    const res = await POST(req({ ...valid, acknowledge: undefined }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('acknowledge_required');
  });

  it('再認証失敗は 403 reauth_failed + 否認を高重要度監査（credential は残さない）', async () => {
    asDeveloper();
    const res = await POST(req({ ...valid, credential: 'wrong' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('reauth_failed');
    const call = recordDangerAction.mock.calls.at(-1)?.[0] as { action: string; metadata: Record<string, string> };
    expect(call.action).toBe('privilege.break_glass');
    expect(call.metadata.result).toBe('denied');
    expect(call.metadata.severity).toBe('high');
    expect(JSON.stringify(call)).not.toContain('wrong');
  });

  it('成功: 200 + breakGlass cookie（15 分固定窓）+ 高重要度監査', async () => {
    asDeveloper();
    const before = Date.now();
    const res = await POST(req(valid));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; until: number; breakGlass: boolean };
    expect(body.ok).toBe(true);
    expect(body.breakGlass).toBe(true);
    // 固定 15 分窓（通常昇格の既定 30 分より短い）。
    expect(body.until).toBeGreaterThanOrEqual(before + BREAK_GLASS_TTL_MS);
    expect(body.until).toBeLessThanOrEqual(Date.now() + BREAK_GLASS_TTL_MS);

    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${ELEVATION_COOKIE}=`);
    expect(setCookie.toLowerCase()).toContain('httponly');
    const token = /platform_elevation=([^;]+)/.exec(setCookie)?.[1];
    const read = await readElevation(token);
    expect(read?.breakGlass).toBe(true);

    const call = recordDangerAction.mock.calls.at(-1)?.[0] as { action: string; metadata: Record<string, string> };
    expect(call.action).toBe('privilege.break_glass');
    expect(call.metadata.breakGlass).toBe('true');
    expect(call.metadata.severity).toBe('high');
  });

  it('break-glass 昇格でも assertElevated の同じ強制（sub 束縛・jti）で write が解禁される', async () => {
    asDeveloper();
    const res = await POST(req(valid));
    const token = /platform_elevation=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
    cookieGet.mockImplementation((n) => (n === ELEVATION_COOKIE ? { value: token! } : undefined));
    const r = await assertElevated();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.elevation.breakGlass).toBe(true);
  });

  it('break-glass の終了（/elevate/end）も高重要度監査で記録される', async () => {
    asDeveloper();
    const res = await POST(req(valid));
    const token = /platform_elevation=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
    cookieGet.mockImplementation((n) => (n === ELEVATION_COOKIE ? { value: token! } : undefined));

    const end = await ELEVATE_END(new Request('http://t/api/platform/elevate/end', { method: 'POST' }));
    expect(end.status).toBe(200);
    expect(await end.json()).toEqual({ ok: true, ended: true });
    const call = recordDangerAction.mock.calls.at(-1)?.[0] as { action: string; metadata: Record<string, string> };
    expect(call.action).toBe('privilege.break_glass');
    expect(call.metadata.result).toBe('revoked');
    expect(call.metadata.severity).toBe('high');
    expect((await assertElevated()).ok).toBe(false); // end 後は break-glass も即時失効。
  });
});
