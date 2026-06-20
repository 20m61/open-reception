import { describe, expect, it } from 'vitest';
import type { AuditLog, ReceptionLog } from '@/domain/reception/log';
import {
  currentMonthPeriod,
  isWithinPeriod,
  previousMonthPeriod,
  summarizeUsage,
  type UsagePeriod,
} from './usage-summary';

const NOW = new Date('2026-06-20T12:00:00.000Z');
const JUNE: UsagePeriod = { start: '2026-06-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z' };

function rlog(
  over: Partial<ReceptionLog> & Pick<ReceptionLog, 'id' | 'outcome' | 'startedAt'>,
): ReceptionLog {
  return {
    receptionId: `rcp-${over.id}`,
    kioskId: 'kiosk-1',
    fallbackUsed: false,
    endedAt: over.startedAt,
    durationMs: 0,
    createdAt: over.startedAt,
    ...over,
  };
}

describe('isWithinPeriod (#89)', () => {
  it('半開区間 [start, end) で判定する（start は含み end は含まない）', () => {
    expect(isWithinPeriod('2026-06-01T00:00:00.000Z', JUNE)).toBe(true);
    expect(isWithinPeriod('2026-06-30T23:59:59.999Z', JUNE)).toBe(true);
    expect(isWithinPeriod('2026-07-01T00:00:00.000Z', JUNE)).toBe(false);
    expect(isWithinPeriod('2026-05-31T23:59:59.999Z', JUNE)).toBe(false);
  });

  it('不正な日付は期間外として扱う', () => {
    expect(isWithinPeriod('not-a-date', JUNE)).toBe(false);
  });
});

describe('currentMonthPeriod / previousMonthPeriod (#89)', () => {
  it('当月は [当月初, 翌月初) を返す', () => {
    expect(currentMonthPeriod(NOW)).toEqual({
      start: '2026-06-01T00:00:00.000Z',
      end: '2026-07-01T00:00:00.000Z',
    });
  });

  it('前月は [前月初, 当月初) を返す', () => {
    expect(previousMonthPeriod(NOW)).toEqual({
      start: '2026-05-01T00:00:00.000Z',
      end: '2026-06-01T00:00:00.000Z',
    });
  });

  it('年初（1月）の前月は前年12月になる', () => {
    const jan = new Date('2026-01-15T00:00:00.000Z');
    expect(previousMonthPeriod(jan)).toEqual({
      start: '2025-12-01T00:00:00.000Z',
      end: '2026-01-01T00:00:00.000Z',
    });
  });
});

describe('summarizeUsage (#89)', () => {
  it('期間内の受付を成否別・代替導線・通話分数で集計する', () => {
    const logs: ReceptionLog[] = [
      rlog({ id: 'a', outcome: 'connected', startedAt: '2026-06-02T09:00:00.000Z', durationMs: 90_000 }),
      rlog({ id: 'b', outcome: 'connected', startedAt: '2026-06-03T09:00:00.000Z', durationMs: 30_000 }),
      rlog({ id: 'c', outcome: 'timeout', startedAt: '2026-06-04T09:00:00.000Z', fallbackUsed: true }),
      rlog({ id: 'd', outcome: 'failed', startedAt: '2026-06-05T09:00:00.000Z', fallbackUsed: true }),
      rlog({ id: 'e', outcome: 'cancelled', startedAt: '2026-06-06T09:00:00.000Z' }),
      // 期間外（前月）は除外
      rlog({ id: 'f', outcome: 'connected', startedAt: '2026-05-30T09:00:00.000Z', durationMs: 600_000 }),
    ];
    const u = summarizeUsage(logs, [], JUNE);
    expect(u.receptions).toBe(5);
    expect(u.connectedCalls).toBe(2);
    expect(u.timeoutCalls).toBe(1);
    expect(u.failedCalls).toBe(1);
    expect(u.fallbackUsed).toBe(2);
    // 90s + 30s = 120s = 2 分（切り上げ）
    expect(u.connectedCallMinutes).toBe(2);
  });

  it('通話分数は分未満を切り上げる', () => {
    const logs = [rlog({ id: 'x', outcome: 'connected', startedAt: '2026-06-02T09:00:00.000Z', durationMs: 61_000 })];
    expect(summarizeUsage(logs, [], JUNE).connectedCallMinutes).toBe(2);
  });

  it('空データでは全カウント 0', () => {
    const u = summarizeUsage([], [], JUNE);
    expect(u).toMatchObject({
      receptions: 0,
      connectedCalls: 0,
      timeoutCalls: 0,
      failedCalls: 0,
      fallbackUsed: 0,
      connectedCallMinutes: 0,
      adminLogins: 0,
      integrationFailures: 0,
    });
  });

  it('監査由来の指標（ログイン・連携失敗）は現状ソースが無く 0 だがフィールドは返す', () => {
    const audit: AuditLog[] = [
      { id: 'au1', action: 'security.updated', actor: 'admin', at: '2026-06-10T00:00:00.000Z' },
      { id: 'au2', action: 'integration.tested', actor: 'admin', at: '2026-06-10T00:00:00.000Z' },
    ];
    const u = summarizeUsage([], audit, JUNE);
    expect(u.adminLogins).toBe(0);
    expect(u.integrationFailures).toBe(0);
  });
});
