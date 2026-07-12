import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUDIT_LOG_RETENTION_DAYS,
  DEFAULT_RECEPTION_LOG_RETENTION_DAYS,
  MIN_AUDIT_LOG_RETENTION_DAYS,
  resolveAuditLogRetentionDays,
  resolveReceptionLogRetentionDays,
  retentionDaysToTtl,
} from './limits';

describe('resolveReceptionLogRetentionDays (#313)', () => {
  it('テナント設定が無ければ既定値', () => {
    expect(resolveReceptionLogRetentionDays(undefined)).toBe(DEFAULT_RECEPTION_LOG_RETENTION_DAYS);
    expect(resolveReceptionLogRetentionDays({})).toBe(DEFAULT_RECEPTION_LOG_RETENTION_DAYS);
  });

  it('テナント設定があればそれを優先する', () => {
    expect(resolveReceptionLogRetentionDays({ receptionLogRetentionDays: 30 })).toBe(30);
  });

  it('0 以下・非数は既定値へフォールバックする（不正値の防御）', () => {
    expect(resolveReceptionLogRetentionDays({ receptionLogRetentionDays: 0 })).toBe(
      DEFAULT_RECEPTION_LOG_RETENTION_DAYS,
    );
    expect(resolveReceptionLogRetentionDays({ receptionLogRetentionDays: -5 })).toBe(
      DEFAULT_RECEPTION_LOG_RETENTION_DAYS,
    );
    expect(resolveReceptionLogRetentionDays({ receptionLogRetentionDays: NaN })).toBe(
      DEFAULT_RECEPTION_LOG_RETENTION_DAYS,
    );
  });
});

describe('resolveAuditLogRetentionDays (#313 — 監査ログの下限保持期間)', () => {
  it('テナント設定が無ければ既定値（受付履歴より長め）', () => {
    expect(resolveAuditLogRetentionDays(undefined)).toBe(DEFAULT_AUDIT_LOG_RETENTION_DAYS);
    expect(DEFAULT_AUDIT_LOG_RETENTION_DAYS).toBeGreaterThan(DEFAULT_RECEPTION_LOG_RETENTION_DAYS);
  });

  it('テナント設定が下限以上ならそのまま使う', () => {
    const requested = MIN_AUDIT_LOG_RETENTION_DAYS + 10;
    expect(resolveAuditLogRetentionDays({ auditLogRetentionDays: requested })).toBe(requested);
  });

  it('テナント設定が下限より短いときは下限へ切り上げる（設定より短くできない）', () => {
    expect(
      resolveAuditLogRetentionDays({ auditLogRetentionDays: MIN_AUDIT_LOG_RETENTION_DAYS - 1 }),
    ).toBe(MIN_AUDIT_LOG_RETENTION_DAYS);
    expect(resolveAuditLogRetentionDays({ auditLogRetentionDays: 1 })).toBe(MIN_AUDIT_LOG_RETENTION_DAYS);
  });

  it('floorDays を渡すと運用者側でその下限まで引き上げられる', () => {
    expect(
      resolveAuditLogRetentionDays({ auditLogRetentionDays: 100 }, 200),
    ).toBe(200);
  });

  it('0 以下・非数の floorDays は既定下限へフォールバックする', () => {
    expect(resolveAuditLogRetentionDays({ auditLogRetentionDays: 1 }, 0)).toBe(
      MIN_AUDIT_LOG_RETENTION_DAYS,
    );
  });
});

describe('retentionDaysToTtl (#313)', () => {
  it('anchor 起点で days 日後の epoch 秒を返す', () => {
    const anchor = Date.parse('2026-01-01T00:00:00.000Z');
    const ttl = retentionDaysToTtl(180, anchor);
    expect(ttl).toBe(Math.floor(anchor / 1000) + 180 * 24 * 60 * 60);
  });

  it('anchor 省略時は現在時刻を起点にする', () => {
    const before = Math.floor(Date.now() / 1000);
    const ttl = retentionDaysToTtl(1);
    expect(ttl).toBeGreaterThanOrEqual(before + 24 * 60 * 60);
  });

  it('0 以下の days は安全側で 0 扱い（起点そのまま）', () => {
    const anchor = Date.parse('2026-01-01T00:00:00.000Z');
    expect(retentionDaysToTtl(0, anchor)).toBe(Math.floor(anchor / 1000));
    expect(retentionDaysToTtl(-10, anchor)).toBe(Math.floor(anchor / 1000));
  });
});
