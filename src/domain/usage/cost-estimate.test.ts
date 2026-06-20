import { describe, expect, it } from 'vitest';
import type { UsageSummary } from './usage-summary';
import {
  DEFAULT_COST_ASSUMPTIONS,
  estimateCost,
  monthProgress,
  projectMonthEnd,
  type CostAssumptions,
} from './cost-estimate';

const NOW = new Date('2026-06-20T12:00:00.000Z'); // 6月: 30日, 経過20日
const PERIOD = { start: '2026-06-01T00:00:00.000Z', end: '2026-07-01T00:00:00.000Z' };

function usage(over: Partial<UsageSummary> = {}): UsageSummary {
  return {
    period: PERIOD,
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

const ASSUMPTIONS: CostAssumptions = {
  vonagePerCallMinute: 15,
  awsPerReception: 2,
  monthlyWarnThreshold: 50000,
};

describe('monthProgress (#89)', () => {
  it('6月20日は経過20日・総日数30日', () => {
    expect(monthProgress(NOW)).toEqual({ elapsedDays: 20, daysInMonth: 30 });
  });

  it('2月（うるう年でない2025年）は28日', () => {
    expect(monthProgress(new Date('2025-02-10T00:00:00.000Z')).daysInMonth).toBe(28);
  });
});

describe('projectMonthEnd (#89)', () => {
  it('日割りペースを月末まで線形外挿する', () => {
    // 1000円 / 20日 = 50円/日 × 30日 = 1500円
    expect(projectMonthEnd(1000, 20, 30)).toBe(1500);
  });

  it('経過0日や月初は soFar をそのまま返す（0除算回避）', () => {
    expect(projectMonthEnd(1000, 0, 30)).toBe(1000);
    expect(projectMonthEnd(0, 20, 30)).toBe(0);
  });
});

describe('estimateCost (#89)', () => {
  it('利用量×単価でサービス別内訳と合計を概算する', () => {
    const u = usage({ receptions: 100, connectedCallMinutes: 200 });
    const est = estimateCost(u, null, NOW, ASSUMPTIONS);
    // vonage: 200×15=3000, aws: 100×2=200 → 3200
    expect(est.estimatedSoFar).toBe(3200);
    expect(est.breakdown).toHaveLength(2);
    expect(est.breakdown.find((b) => b.service === 'vonage')?.estimated).toBe(3000);
    expect(est.breakdown.find((b) => b.service === 'aws')?.estimated).toBe(200);
  });

  it('月末予想を日割りで外挿する', () => {
    const u = usage({ receptions: 100, connectedCallMinutes: 200 }); // soFar=3200, 経過20/30日
    const est = estimateCost(u, null, NOW, ASSUMPTIONS);
    expect(est.projectedMonthEnd).toBe(Math.round((3200 / 20) * 30)); // 4800
  });

  it('「概算」「予想」であることと通貨・単価仮定を必ず同梱する', () => {
    const est = estimateCost(usage(), null, NOW, ASSUMPTIONS);
    expect(est.isEstimate).toBe(true);
    expect(est.currency).toBe('JPY');
    expect(est.assumptions).toEqual(ASSUMPTIONS);
  });

  it('前月利用量があれば前月比較を返す', () => {
    const current = usage({ connectedCallMinutes: 200 }); // 3000
    const prev = usage({ connectedCallMinutes: 100 }); // 1500
    const est = estimateCost(current, prev, NOW, ASSUMPTIONS);
    expect(est.previousMonthComparison).toEqual({ previousEstimated: 1500, delta: 1500 });
  });

  it('前月データが無ければ比較は null', () => {
    expect(estimateCost(usage(), null, NOW, ASSUMPTIONS).previousMonthComparison).toBeNull();
  });

  it('月末予想がしきい値を超えたら warning を立てる', () => {
    // soFar が大きく、外挿で 50000 を超えるケース
    const u = usage({ receptions: 0, connectedCallMinutes: 3000 }); // 45000, 外挿 67500
    const est = estimateCost(u, null, NOW, ASSUMPTIONS);
    expect(est.threshold?.exceeded).toBe(true);
  });

  it('しきい値内なら exceeded=false', () => {
    const est = estimateCost(usage({ connectedCallMinutes: 10 }), null, NOW, ASSUMPTIONS);
    expect(est.threshold?.exceeded).toBe(false);
  });

  it('threshold<=0 なら警告自体を出さない（null）', () => {
    const est = estimateCost(usage(), null, NOW, { ...ASSUMPTIONS, monthlyWarnThreshold: 0 });
    expect(est.threshold).toBeNull();
  });

  it('既定単価仮定でも空利用量なら 0 円・0 円', () => {
    const est = estimateCost(usage(), null, NOW, DEFAULT_COST_ASSUMPTIONS);
    expect(est.estimatedSoFar).toBe(0);
    expect(est.projectedMonthEnd).toBe(0);
  });
});
