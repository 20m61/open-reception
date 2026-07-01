import { describe, expect, it } from 'vitest';
import type { AuditLog, ReceptionLog } from '@/domain/reception/log';
import {
  buildUsageTrend,
  currentMonthPeriod,
  deriveUsageRates,
  isWithinPeriod,
  previousMonthPeriod,
  summarizeUsage,
  type UsagePeriod,
  type UsageSummary,
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

describe('currentMonthPeriod / previousMonthPeriod (#89 / JST 月境界 #254)', () => {
  // 月境界は JST 月初 00:00（= UTC 前日 15:00）。NOW=2026-06-20 は JST でも 6 月。
  it('当月は [当月初, 翌月初) を JST 月境界で返す', () => {
    expect(currentMonthPeriod(NOW)).toEqual({
      start: '2026-05-31T15:00:00.000Z', // 2026-06-01 00:00 JST
      end: '2026-06-30T15:00:00.000Z', // 2026-07-01 00:00 JST
    });
  });

  it('前月は [前月初, 当月初) を JST 月境界で返す', () => {
    expect(previousMonthPeriod(NOW)).toEqual({
      start: '2026-04-30T15:00:00.000Z', // 2026-05-01 00:00 JST
      end: '2026-05-31T15:00:00.000Z', // 2026-06-01 00:00 JST
    });
  });

  it('年初（1月）の前月は前年12月になる（JST）', () => {
    const jan = new Date('2026-01-15T00:00:00.000Z'); // JST 2026-01-15 09:00 → 1 月
    expect(previousMonthPeriod(jan)).toEqual({
      start: '2025-11-30T15:00:00.000Z', // 2025-12-01 00:00 JST
      end: '2025-12-31T15:00:00.000Z', // 2026-01-01 00:00 JST
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

function summary(over: Partial<UsageSummary> = {}): UsageSummary {
  return {
    period: JUNE,
    receptions: 0,
    connectedCalls: 0,
    timeoutCalls: 0,
    failedCalls: 0,
    fallbackUsed: 0,
    connectedCallMinutes: 0,
    adminLogins: 0,
    integrationFailures: 0,
    ...over,
  };
}

describe('deriveUsageRates (#89 inc2)', () => {
  it('成功率・未応答率・失敗率・代替導線率を受付件数で割って返す', () => {
    const r = deriveUsageRates(
      summary({ receptions: 10, connectedCalls: 7, timeoutCalls: 2, failedCalls: 1, fallbackUsed: 3 }),
    );
    expect(r.connectedRate).toBeCloseTo(0.7);
    expect(r.timeoutRate).toBeCloseTo(0.2);
    expect(r.failedRate).toBeCloseTo(0.1);
    expect(r.fallbackRate).toBeCloseTo(0.3);
  });

  it('受付件数 0 のときは分母なしで全て null（虚の割合を出さない）', () => {
    const r = deriveUsageRates(summary({ receptions: 0, connectedCalls: 0 }));
    expect(r).toEqual({ connectedRate: null, timeoutRate: null, failedRate: null, fallbackRate: null });
  });
});

describe('buildUsageTrend (#89 inc2)', () => {
  it('日次バケットに受付・接続・通話分数を割り当てる', () => {
    const logs: ReceptionLog[] = [
      rlog({ id: 'a', outcome: 'connected', startedAt: '2026-06-01T01:00:00.000Z', durationMs: 90_000 }),
      rlog({ id: 'b', outcome: 'connected', startedAt: '2026-06-01T05:00:00.000Z', durationMs: 30_000 }),
      rlog({ id: 'c', outcome: 'timeout', startedAt: '2026-06-02T09:00:00.000Z' }),
    ];
    const trend = buildUsageTrend(logs, JUNE);
    const d1 = trend.find((p) => p.date === '2026-06-01');
    const d2 = trend.find((p) => p.date === '2026-06-02');
    expect(d1).toEqual({ date: '2026-06-01', receptions: 2, connectedCalls: 2, connectedCallMinutes: 2 });
    expect(d2).toEqual({ date: '2026-06-02', receptions: 1, connectedCalls: 0, connectedCallMinutes: 0 });
  });

  it('期間内の全日を 0 埋めで連続して返す（6月は30点）', () => {
    const trend = buildUsageTrend([], JUNE);
    expect(trend).toHaveLength(30);
    expect(trend.at(0)?.date).toBe('2026-06-01');
    expect(trend.at(-1)?.date).toBe('2026-06-30');
    expect(trend.every((p) => p.receptions === 0)).toBe(true);
  });

  it('期間外のログはどのバケットにも入らない', () => {
    const logs = [rlog({ id: 'x', outcome: 'connected', startedAt: '2026-05-31T23:00:00.000Z', durationMs: 60_000 })];
    const trend = buildUsageTrend(logs, JUNE);
    expect(trend.every((p) => p.receptions === 0)).toBe(true);
  });
});
