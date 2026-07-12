/**
 * 受付履歴・監査ログの TTL 解決 (issue #313) のテスト。
 * 既定テナント（default-scope）の TenantLimits を変更すると、以後の解決に反映されることを固定する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIN_AUDIT_LOG_RETENTION_DAYS } from '@/domain/tenant/limits';
import { __resetBackend } from '@/lib/data';
import { defaultTenantIdFrom } from '@/lib/tenant/default-scope';
import { DataBackedTenantLimitsRepository } from '@/lib/tenant/limits-store';
import { resolveAuditLogTtl, resolveReceptionLogTtl } from './log-retention';

afterEach(() => {
  __resetBackend();
  vi.unstubAllEnvs();
});

describe('resolveReceptionLogTtl (#313)', () => {
  it('テナント設定が無ければ既定 180 日相当で ttl を返す', async () => {
    const anchor = Date.parse('2026-07-01T00:00:00.000Z');
    const ttl = await resolveReceptionLogTtl(anchor);
    expect(ttl).toBe(Math.floor(anchor / 1000) + 180 * 24 * 60 * 60);
  });

  it('既定テナントの TenantLimits.receptionLogRetentionDays を変更すると以後の解決へ反映される', async () => {
    const repo = new DataBackedTenantLimitsRepository();
    const tenantId = defaultTenantIdFrom();
    await repo.put({ id: tenantId, receptionLogRetentionDays: 30, updatedAt: '2026-07-01T00:00:00.000Z' });

    const anchor = Date.parse('2026-07-01T00:00:00.000Z');
    const ttl = await resolveReceptionLogTtl(anchor);
    expect(ttl).toBe(Math.floor(anchor / 1000) + 30 * 24 * 60 * 60);
  });
});

describe('resolveAuditLogTtl (#313 — 監査ログの下限保持期間)', () => {
  it('テナント設定が無ければ既定 365 日相当で ttl を返す', async () => {
    const anchor = Date.parse('2026-07-01T00:00:00.000Z');
    const ttl = await resolveAuditLogTtl(anchor);
    expect(ttl).toBe(Math.floor(anchor / 1000) + 365 * 24 * 60 * 60);
  });

  it('テナントが下限より短い保持日数を設定しても、実効 ttl は下限未満にならない', async () => {
    const repo = new DataBackedTenantLimitsRepository();
    const tenantId = defaultTenantIdFrom();
    await repo.put({
      id: tenantId,
      auditLogRetentionDays: MIN_AUDIT_LOG_RETENTION_DAYS - 1,
      updatedAt: '2026-07-01T00:00:00.000Z',
    });

    const anchor = Date.parse('2026-07-01T00:00:00.000Z');
    const ttl = await resolveAuditLogTtl(anchor);
    expect(ttl).toBe(Math.floor(anchor / 1000) + MIN_AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60);
  });

  it('OPEN_RECEPTION_AUDIT_LOG_MIN_RETENTION_DAYS で運用者が下限を引き上げられる', async () => {
    vi.stubEnv('OPEN_RECEPTION_AUDIT_LOG_MIN_RETENTION_DAYS', '500');
    const repo = new DataBackedTenantLimitsRepository();
    const tenantId = defaultTenantIdFrom();
    await repo.put({ id: tenantId, auditLogRetentionDays: 400, updatedAt: '2026-07-01T00:00:00.000Z' });

    const anchor = Date.parse('2026-07-01T00:00:00.000Z');
    const ttl = await resolveAuditLogTtl(anchor);
    expect(ttl).toBe(Math.floor(anchor / 1000) + 500 * 24 * 60 * 60);
  });
});
