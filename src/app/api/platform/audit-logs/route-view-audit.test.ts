/**
 * GET /api/platform/audit-logs の閲覧監査 (issue #83 §5 / inc5b)。
 *
 * 監査ログ閲覧そのものを platform.audit_log.viewed として記録する。閲覧のたびに記録すると
 * 監査ログが自己増殖するため、同一 actor の窓内（15 分）連続閲覧は 1 回に絞る
 * （抑制の根拠はストア上の閲覧監査そのもの＝インスタンス跨ぎでも効く）。
 * あわせて §4（既定マスク）の回帰も確認する（actor の識別子・metadata を露出しない）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@/domain/tenant/authorization';
import type { AuditLog } from '@/domain/reception/log';

const resolveAdminActor = vi.fn<() => Promise<Actor | null>>();
const listAuditLogs = vi.fn<() => Promise<AuditLog[]>>();
const recordPlatformReadAudit = vi.fn<(input: unknown) => Promise<unknown>>();

vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActor: () => resolveAdminActor(),
  resolveAdminActorWithIdentity: async () => {
    const a = await resolveAdminActor();
    return a ? { actor: a, identity: 'dev@example.com' } : null;
  },
}));
vi.mock('@/lib/data-stores/reception-log-store', () => ({ listAuditLogs: () => listAuditLogs() }));
vi.mock('@/lib/platform/read-audit', () => ({
  recordPlatformReadAudit: (i: unknown) => recordPlatformReadAudit(i),
}));

import { GET } from './route';

function developer(): Actor {
  return { status: 'active', assignments: [{ role: 'developer', tenantId: null, siteId: null, deviceId: null }] };
}

const BASE_LOG: AuditLog = {
  id: 'a1',
  action: 'privilege.elevated',
  actor: 'platform:dev@example.com',
  at: '2026-07-02T11:00:00.000Z',
  metadata: { reason: 'x' },
};

function req(query = ''): Request {
  return new Request(`http://t/api/platform/audit-logs${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  resolveAdminActor.mockResolvedValue(developer());
  listAuditLogs.mockResolvedValue([{ ...BASE_LOG }]);
  recordPlatformReadAudit.mockResolvedValue({});
});

describe('GET /api/platform/audit-logs 閲覧監査 (#83 §5)', () => {
  it('閲覧を platform.audit_log.viewed として記録する（actor 帰属・request つき）', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(recordPlatformReadAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.audit_log.viewed',
        identity: 'dev@example.com',
        target: { type: 'audit_log' },
        request: expect.any(Request),
      }),
    );
  });

  it('同一 actor の窓内閲覧記録があれば再記録しない（ループ回避）', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-07-02T12:00:00.000Z') });
    listAuditLogs.mockResolvedValue([
      {
        id: 'v1',
        action: 'platform.audit_log.viewed',
        actor: 'platform:dev@example.com',
        at: '2026-07-02T11:55:00.000Z', // 5 分前 < 15 分窓
      },
      { ...BASE_LOG },
    ]);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(recordPlatformReadAudit).not.toHaveBeenCalled();
  });

  it('窓より古い閲覧記録しか無ければ再び記録する', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-07-02T12:00:00.000Z') });
    listAuditLogs.mockResolvedValue([
      {
        id: 'v1',
        action: 'platform.audit_log.viewed',
        actor: 'platform:dev@example.com',
        at: '2026-07-02T11:30:00.000Z', // 30 分前 > 15 分窓
      },
      { ...BASE_LOG },
    ]);
    await GET(req());
    expect(recordPlatformReadAudit).toHaveBeenCalledTimes(1);
  });

  it('別 actor の閲覧記録では抑制しない', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-07-02T12:00:00.000Z') });
    listAuditLogs.mockResolvedValue([
      {
        id: 'v1',
        action: 'platform.audit_log.viewed',
        actor: 'platform:other@example.com',
        at: '2026-07-02T11:59:00.000Z',
      },
    ]);
    await GET(req());
    expect(recordPlatformReadAudit).toHaveBeenCalledTimes(1);
  });

  it('breakGlass 絞り込みでも閲覧監査は全ログ基準で抑制判定する（絞り込みで窓が素通りしない）', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-07-02T12:00:00.000Z') });
    listAuditLogs.mockResolvedValue([
      {
        id: 'v1',
        action: 'platform.audit_log.viewed',
        actor: 'platform:dev@example.com',
        at: '2026-07-02T11:55:00.000Z',
      },
    ]);
    await GET(req('?breakGlass=1'));
    expect(recordPlatformReadAudit).not.toHaveBeenCalled();
  });

  it('§4 回帰: 応答の actor はマスク済みで、metadata・生メールは露出しない', async () => {
    const body = await (await GET(req())).json();
    const text = JSON.stringify(body);
    expect(text).not.toContain('dev@example.com');
    const rows = body.logs as Record<string, unknown>[];
    expect(rows[0]?.actor).toBe('platform:***');
    for (const row of rows) expect('metadata' in row).toBe(false);
  });

  it('閲覧監査の行自体も応答に載る（透明性）が、閲覧のたびに増殖はしない', async () => {
    listAuditLogs.mockResolvedValue([
      {
        id: 'v1',
        action: 'platform.audit_log.viewed',
        actor: 'platform:dev@example.com',
        at: new Date().toISOString(),
      },
    ]);
    const body = await (await GET(req())).json();
    expect((body.logs as { action: string }[])[0]?.action).toBe('platform.audit_log.viewed');
    expect(recordPlatformReadAudit).not.toHaveBeenCalled();
  });
});
