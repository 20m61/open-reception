/**
 * GET /api/platform/audit-logs の break-glass 抽出（利用後レビュー, issue #83 §3）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import type { AuditLog } from '@/domain/reception/log';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const listAuditLogs = vi.fn<() => Promise<AuditLog[]>>();

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
  resolveAdminActorWithIdentity: async () => {
    const a = await resolveAdminActor();
    return a ? { actor: a, identity: 'dev@example.com' } : null;
  },
}));
vi.mock('@/lib/data-stores/reception-log-store', () => ({ listAuditLogs: () => listAuditLogs() }));

import { GET } from './route';

function developer(): Actor {
  return { status: 'active', assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }] };
}

const LOGS: AuditLog[] = [
  // break-glass 発行（専用 action）。
  { id: 'a1', action: 'privilege.break_glass', actor: 'platform:dev@example.com', at: '2026-07-02T00:00:00Z', metadata: { severity: 'high', result: 'granted' } },
  // break-glass 中の write（既存 action + breakGlass マーク）。
  { id: 'a2', action: 'platform.notice.published', actor: 'platform:dev@example.com', at: '2026-07-02T00:01:00Z', metadata: { breakGlass: 'true', severity: 'high' } },
  // 通常操作。
  { id: 'a3', action: 'platform.notice.published', actor: 'platform:dev@example.com', at: '2026-07-02T00:02:00Z', metadata: { reason: 'x' } },
];

function req(query = ''): Request {
  return new Request(`http://t/api/platform/audit-logs${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveAdminActor.mockResolvedValue(developer());
  listAuditLogs.mockResolvedValue(LOGS);
});

describe('GET /api/platform/audit-logs break-glass (#83 §3)', () => {
  it('既定は全件を返し、break-glass 関連行に breakGlass:true を付ける', async () => {
    const body = await (await GET(req())).json();
    expect(body.logs).toHaveLength(3);
    const byId = new Map((body.logs as { id: string; breakGlass?: boolean }[]).map((r) => [r.id, r]));
    expect(byId.get('a1')?.breakGlass).toBe(true);
    expect(byId.get('a2')?.breakGlass).toBe(true);
    expect(byId.get('a3')?.breakGlass).toBeUndefined();
  });

  it('?breakGlass=1 で break-glass の発行・write のみに絞れる（利用後レビュー）', async () => {
    const body = await (await GET(req('?breakGlass=1'))).json();
    expect((body.logs as { id: string }[]).map((r) => r.id)).toEqual(['a1', 'a2']);
  });

  it('絞り込み結果でも metadata は露出しない（マスク済み行のみ）', async () => {
    const body = await (await GET(req('?breakGlass=1'))).json();
    for (const row of body.logs as Record<string, unknown>[]) {
      expect('metadata' in row).toBe(false);
    }
  });
});
