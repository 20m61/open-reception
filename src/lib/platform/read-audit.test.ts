/**
 * platform read 系監査の記録ヘルパのテスト (issue #83 §5 / inc5b)。
 *
 * appendAuditLog へ「actor 帰属（platform:<identity>）・操作元 IP/UA・sanitize 済み metadata」を
 * 一貫して渡すことを検証する（PII・機微値を残さない）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const appendAuditLog = vi.fn<(entry: Record<string, unknown>) => Promise<unknown>>();
vi.mock('@/lib/data-stores/reception-log-store', () => ({
  appendAuditLog: (e: Record<string, unknown>) => appendAuditLog(e),
}));

import { recordPlatformReadAudit } from './read-audit';

beforeEach(() => {
  vi.clearAllMocks();
  appendAuditLog.mockResolvedValue({});
});

describe('recordPlatformReadAudit (#83 §5)', () => {
  it('actor を platform:<identity> に帰属し、対象と action を記録する', async () => {
    await recordPlatformReadAudit({
      action: 'platform.tenant.viewed',
      identity: 'dev@example.com',
      target: { type: 'tenant', id: 'internal' },
    });
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.tenant.viewed',
        actor: 'platform:dev@example.com',
        targetType: 'tenant',
        targetId: 'internal',
      }),
    );
  });

  it('request から操作元 IP（x-forwarded-for 末尾）と user-agent を残す (#83 AC13 と同じ規約)', async () => {
    const request = new Request('http://t/api/platform/audit-logs', {
      headers: { 'x-forwarded-for': 'spoofed, 203.0.113.9', 'user-agent': 'UA-test' },
    });
    await recordPlatformReadAudit({
      action: 'platform.audit_log.viewed',
      identity: 'dev@example.com',
      target: { type: 'audit_log' },
      request,
    });
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ ip: '203.0.113.9', userAgent: 'UA-test' }),
    );
  });

  it('metadata は sanitize され、機微キーの値は平文で残らない', async () => {
    await recordPlatformReadAudit({
      action: 'platform.tenant_scope.switched',
      identity: 'dev@example.com',
      target: { type: 'tenant', id: 'internal' },
      metadata: { scope: 'all', email: 'visitor@example.com' },
    });
    const entry = appendAuditLog.mock.calls[0]?.[0] as { metadata?: Record<string, string> };
    expect(entry.metadata?.scope).toBe('all');
    expect(entry.metadata?.email).toBe('[redacted]');
  });
});
