/**
 * GET /api/platform/feature-flags のテナント別フラグサマリのテスト (issue #83 inc5a)。
 * inc2 で pending だった voiceSynthesis / avatarReception を、テナント上書きレコードの
 * サマリ（既定値 + 無効化テナント数）として実接続したことを検証する。
 * 認可・vonage/limits の既存挙動は route-inc2.test.ts が引き続き検証する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import type { TenantFeatureFlagRecord } from '@/domain/platform/feature-flags';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const listRecords = vi.fn<() => Promise<TenantFeatureFlagRecord[]>>();

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
  resolveAdminActorWithIdentity: async () => {
    const a = await resolveAdminActor();
    return a ? { actor: a, identity: 'dev@example.com' } : null;
  },
}));
vi.mock('@/lib/platform/feature-flag-store', () => ({
  listTenantFeatureFlagRecords: () => listRecords(),
}));

import { GET } from './route';

function developer(): Actor {
  return { status: 'active', assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }] };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveAdminActor.mockResolvedValue(developer());
  listRecords.mockResolvedValue([]);
});

describe('GET /api/platform/feature-flags — テナント別フラグサマリ (#83 inc5a)', () => {
  it('上書きが無ければ既定有効・無効化テナント 0 件', async () => {
    const body = await (await GET()).json();
    expect(body.flags.voiceSynthesis).toEqual({ defaultEnabled: true, disabledTenants: 0 });
    expect(body.flags.avatarReception).toEqual({ defaultEnabled: true, disabledTenants: 0 });
  });

  it('無効化したテナント数を集計する（既定値と同じ上書きは数えない）', async () => {
    listRecords.mockResolvedValue([
      { id: 't1', flags: { voiceSynthesis: false }, updatedAt: '2026-06-01T00:00:00.000Z' },
      { id: 't2', flags: { voiceSynthesis: false, avatarReception: false }, updatedAt: '2026-06-01T00:00:00.000Z' },
      { id: 't3', flags: { voiceSynthesis: true }, updatedAt: '2026-06-01T00:00:00.000Z' },
    ]);
    const body = await (await GET()).json();
    expect(body.flags.voiceSynthesis).toEqual({ defaultEnabled: true, disabledTenants: 2 });
    expect(body.flags.avatarReception).toEqual({ defaultEnabled: true, disabledTenants: 1 });
  });
});
