/**
 * POST /api/platform/notices（お知らせ登録）の JIT 昇格ゲート・検証・監査 (issue #83 inc4c)。
 * 共有ハンドラ handlePlatformDangerCreate 経由。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import type { Notice } from '@/domain/platform/notice';
import { grantElevation } from '@/domain/auth/elevation';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const cookieGet = vi.fn<(name: string) => { value: string } | undefined>();
const createNotice = vi.fn<(n: Notice) => Promise<void>>();
const recordDangerAction = vi.fn<(i: unknown) => Promise<unknown>>();

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
  resolveAdminActorWithIdentity: async () => {
    const a = await resolveAdminActor();
    return a ? { actor: a, identity: 'dev@example.com' } : null;
  },
}));
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve({ get: (n: string) => cookieGet(n) }) }));
vi.mock('@/lib/platform/notice-store', () => ({ createNotice: (n: Notice) => createNotice(n) }));
vi.mock('@/lib/admin/audit', () => ({ recordDangerAction: (i: unknown) => recordDangerAction(i) }));

import { POST } from './route';
import { issueElevationToken, ELEVATION_COOKIE } from '@/lib/platform/elevation';

function developer(): Actor {
  return { status: 'active', assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }] };
}
async function elevate(): Promise<void> {
  const token = await issueElevationToken(grantElevation({ reason: 'お知らせ掲示', scope: {} }, Date.now()), 'j', 'dev@example.com');
  cookieGet.mockImplementation((n) => (n === ELEVATION_COOKIE ? { value: token } : undefined));
}
function post(body: unknown): Promise<Response> {
  return POST(new Request('http://x/api/platform/notices', { method: 'POST', body: JSON.stringify(body) }));
}

const VALID = { scope: 'platform', level: 'warning', title: 'メンテ告知', body: '本文', reason: '周知' };

beforeEach(() => {
  vi.clearAllMocks();
  cookieGet.mockReturnValue(undefined);
  resolveAdminActor.mockResolvedValue(developer());
});

describe('POST /api/platform/notices (#83)', () => {
  it('developer でも未昇格は 403 elevation_required', async () => {
    const res = await post(VALID);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('elevation_required');
    expect(createNotice).not.toHaveBeenCalled();
  });

  it('昇格済みでも不正入力は 400', async () => {
    await elevate();
    expect((await post({ ...VALID, level: 'x' })).status).toBe(400);
    expect(createNotice).not.toHaveBeenCalled();
  });

  it('昇格済みは登録でき、201 + 保存(published) + 監査（理由つき・createdBy 非露出）', async () => {
    await elevate();
    const res = await post(VALID);
    expect(res.status).toBe(201);
    expect(createNotice).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', status: 'published' }));
    expect(recordDangerAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'platform.notice.published', reason: '周知' }),
    );
    expect('createdBy' in (await res.json()).notice).toBe(false);
  });
});
