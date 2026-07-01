/**
 * POST /api/platform/incidents（障害登録）の JIT 昇格ゲート・検証・監査 (issue #83 AC7 inc4c)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import type { Incident } from '@/domain/platform/incident';
import { grantElevation } from '@/domain/auth/elevation';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const cookieGet = vi.fn<(name: string) => { value: string } | undefined>();
const createIncident = vi.fn<(i: Incident) => Promise<void>>();
const recordDangerAction = vi.fn<(i: unknown) => Promise<unknown>>();

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
  // assertElevated は identity を要する。resolveAdminActor 由来で identity は cookie sub と一致させる。
  resolveAdminActorWithIdentity: async () => {
    const a = await resolveAdminActor();
    return a ? { actor: a, identity: 'dev@example.com' } : null;
  },
}));
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve({ get: (n: string) => cookieGet(n) }) }));
vi.mock('@/lib/platform/incident-store', () => ({ createIncident: (i: Incident) => createIncident(i) }));
vi.mock('@/lib/admin/audit', () => ({ recordDangerAction: (i: unknown) => recordDangerAction(i) }));

import { POST } from './route';
import { issueElevationToken, ELEVATION_COOKIE } from '@/lib/platform/elevation';

function developer(): Actor {
  return { status: 'active', assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }] };
}
async function elevate(): Promise<void> {
  const token = await issueElevationToken(grantElevation({ reason: '障害登録のため', scope: {} }, Date.now()), 'j', 'dev@example.com');
  cookieGet.mockImplementation((n) => (n === ELEVATION_COOKIE ? { value: token } : undefined));
}
function post(body: unknown): Promise<Response> {
  return POST(new Request('http://x/api/platform/incidents', { method: 'POST', body: JSON.stringify(body) }));
}

const VALID = { scope: 'platform', severity: 'major', title: '通話障害', message: '担当者呼び出しが失敗', reason: '影響大' };

beforeEach(() => {
  vi.clearAllMocks();
  cookieGet.mockReturnValue(undefined);
  resolveAdminActor.mockResolvedValue(developer());
});

describe('POST /api/platform/incidents (#83 AC7)', () => {
  it('未認証は 401', async () => {
    resolveAdminActor.mockResolvedValue(null);
    expect((await post(VALID)).status).toBe(401);
    expect(createIncident).not.toHaveBeenCalled();
  });

  it('developer でも未昇格は 403 elevation_required', async () => {
    const res = await post(VALID);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('elevation_required');
    expect(createIncident).not.toHaveBeenCalled();
  });

  it('昇格済みでも不正入力は 400（登録しない）', async () => {
    await elevate();
    expect((await post({ scope: 'bogus', severity: 'major', title: 't', message: 'm' })).status).toBe(400);
    expect((await post({ scope: 'platform', severity: 'major', title: '', message: 'm' })).status).toBe(400);
    // tenant スコープで tenantId 欠落。
    expect((await post({ scope: 'tenant', severity: 'minor', title: 't', message: 'm' })).status).toBe(400);
    expect(createIncident).not.toHaveBeenCalled();
  });

  it('昇格済みは登録でき、201 + 障害保存 + 監査（理由つき）が残る', async () => {
    await elevate();
    const res = await post(VALID);
    expect(res.status).toBe(201);
    expect(createIncident).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'platform',
        severity: 'major',
        status: 'investigating',
        title: '通話障害',
        updatedBy: 'dev@example.com', // 記録も操作者に帰属（#264）。
      }),
    );
    expect(recordDangerAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.incident.created',
        reason: '影響大',
        actor: 'platform:dev@example.com', // 昇格した操作者を監査に帰属（#264）。
        request: expect.any(Request),
      }),
    );
    // 横断レスポンスに updatedBy を載せない。
    expect('updatedBy' in (await res.json()).incident).toBe(false);
  });
});
