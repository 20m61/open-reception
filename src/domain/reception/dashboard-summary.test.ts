import { describe, expect, it } from 'vitest';
import type { ReceptionLog } from './log';
import {
  buildDashboardSummary,
  deriveOverallStatus,
  filterWithinJstDays,
  recentCalls,
  summarizeExperiencePeriods,
  summarizeToday,
  type DeviceSummary,
} from './dashboard-summary';

/** 端末死活サマリのフィクスチャ（#261: 分母 total は稼働可能端末のみ）。 */
function fleet(over: Partial<DeviceSummary> = {}): DeviceSummary {
  return { total: 0, online: 0, offline: 0, maintenance: 0, disabled: 0, ...over };
}

const NOW = new Date('2026-06-20T12:00:00.000Z');

function log(over: Partial<ReceptionLog> & Pick<ReceptionLog, 'id' | 'outcome' | 'startedAt'>): ReceptionLog {
  return {
    receptionId: `rcp-${over.id}`,
    kioskId: 'kiosk-1',
    fallbackUsed: false,
    endedAt: over.startedAt,
    durationMs: 1000,
    createdAt: over.startedAt,
    ...over,
  };
}

describe('summarizeToday (#86)', () => {
  it('本日分のみを件数・成否別に集計し、前日分を除外する', () => {
    const logs: ReceptionLog[] = [
      log({ id: 'a', outcome: 'connected', startedAt: '2026-06-20T09:00:00.000Z' }),
      log({ id: 'b', outcome: 'failed', startedAt: '2026-06-20T10:00:00.000Z', fallbackUsed: true }),
      log({ id: 'c', outcome: 'timeout', startedAt: '2026-06-20T11:00:00.000Z' }),
      // 前日分は対象外（TZ に依存せず確実に別日になるよう 24h 以上前にする）
      log({ id: 'd', outcome: 'connected', startedAt: '2026-06-18T12:00:00.000Z' }),
    ];
    const today = summarizeToday(logs, NOW);
    expect(today.total).toBe(3);
    expect(today.connected).toBe(1);
    expect(today.failed).toBe(1);
    expect(today.timeout).toBe(1);
    expect(today.cancelled).toBe(0);
    expect(today.fallbackUsed).toBe(1);
  });

  it('空履歴では全カウントが 0', () => {
    const today = summarizeToday([], NOW);
    expect(today).toEqual({ total: 0, connected: 0, timeout: 0, failed: 0, cancelled: 0, fallbackUsed: 0 });
  });

  it('不正な日付文字列は本日扱いしない', () => {
    const today = summarizeToday([log({ id: 'x', outcome: 'connected', startedAt: 'not-a-date' })], NOW);
    expect(today.total).toBe(0);
  });

  it('無効な now は本日なしへ degrade（例外を投げない, #254 レビュー）', () => {
    const today = summarizeToday(
      [log({ id: 'a', outcome: 'connected', startedAt: '2026-06-20T09:00:00.000Z' })],
      new Date('invalid'),
    );
    expect(today.total).toBe(0);
  });

  it('「本日」は JST で判定する（UTC 暦日と食い違う早朝/深夜も正しく計上, #254）', () => {
    // now = 2026-07-01 11:00 JST（= 2026-07-01T02:00Z）。
    const nowJst = new Date('2026-07-01T02:00:00.000Z');
    const today = summarizeToday(
      [
        // JST 2026-07-01 05:00（= 06-30T20:00Z）。UTC 暦日は 6/30 だが JST では本日 → 計上する。
        log({ id: 'early-jst', outcome: 'connected', startedAt: '2026-06-30T20:00:00.000Z' }),
        // JST 2026-06-30 23:00（= 06-30T14:00Z）。UTC 暦日は 6/30 で now(UTC 7/1)と一致するが、
        // JST では前日 → 計上しない（UTC 判定だと誤って本日に入る境界ケース）。
        log({ id: 'yesterday-jst', outcome: 'connected', startedAt: '2026-06-30T14:00:00.000Z' }),
      ],
      nowJst,
    );
    expect(today.total).toBe(1);
    expect(today.connected).toBe(1);
  });
});

describe('recentCalls (#86)', () => {
  it('新しい順に最大 limit 件、PII を含めず返す', () => {
    const logs: ReceptionLog[] = [
      log({ id: 'old', outcome: 'connected', startedAt: '2026-06-20T08:00:00.000Z' }),
      log({ id: 'new', outcome: 'failed', startedAt: '2026-06-20T11:00:00.000Z' }),
      log({ id: 'mid', outcome: 'timeout', startedAt: '2026-06-20T10:00:00.000Z' }),
    ];
    const recent = recentCalls(logs, 2);
    expect(recent.map((r) => r.id)).toEqual(['new', 'mid']);
    // 表示形に visitor/PII フィールドが無いことを保証
    expect(Object.keys(recent[0] ?? {}).sort()).toEqual(
      ['durationMs', 'fallbackUsed', 'id', 'kioskId', 'outcome', 'startedAt', 'targetLabel'].sort(),
    );
  });
});

describe('deriveOverallStatus (#86)', () => {
  const base = { total: 0, connected: 0, timeout: 0, failed: 0, cancelled: 0, fallbackUsed: 0 };

  it('全端末オフラインは critical', () => {
    expect(deriveOverallStatus(base, fleet({ total: 2, offline: 2 }))).toBe('critical');
  });

  it('呼び出し失敗があれば warning', () => {
    expect(deriveOverallStatus({ ...base, failed: 1 }, fleet({ total: 2, online: 2 }))).toBe('warning');
  });

  it('一部端末オフラインは warning', () => {
    expect(deriveOverallStatus(base, fleet({ total: 2, online: 1, offline: 1 }))).toBe('warning');
  });

  it('問題なしは ok', () => {
    expect(deriveOverallStatus({ ...base, connected: 3 }, fleet({ total: 2, online: 2 }))).toBe('ok');
  });

  it('端末未登録（total=0）は critical にしない', () => {
    expect(deriveOverallStatus(base, fleet())).toBe('ok');
  });

  it('全台が保守/無効（分母 0）は critical にしない（意図的な停止, #261）', () => {
    expect(deriveOverallStatus(base, fleet({ maintenance: 1, disabled: 1 }))).toBe('ok');
  });
});

describe('filterWithinJstDays (#319 期間指定)', () => {
  // NOW = 2026-06-20T12:00:00Z（JST 06-20 21:00）。JST 暦日で「直近 N 日」を切る。
  const logs: ReceptionLog[] = [
    log({ id: 'today', outcome: 'connected', startedAt: '2026-06-20T09:00:00.000Z' }), // JST 06-20
    log({ id: 'd5', outcome: 'connected', startedAt: '2026-06-15T09:00:00.000Z' }), // JST 06-15（7日窓内）
    log({ id: 'd26', outcome: 'connected', startedAt: '2026-05-25T09:00:00.000Z' }), // JST 05-25（30日窓内・7日窓外）
    log({ id: 'd41', outcome: 'connected', startedAt: '2026-05-10T09:00:00.000Z' }), // JST 05-10（全窓外）
  ];

  it('days=1 は本日のみ（summarizeToday と同じ JST 境界）', () => {
    expect(filterWithinJstDays(logs, NOW, 1).map((l) => l.id)).toEqual(['today']);
  });

  it('days=7 は本日を含む直近7 JST 暦日', () => {
    expect(filterWithinJstDays(logs, NOW, 7).map((l) => l.id).sort()).toEqual(['d5', 'today']);
  });

  it('days=30 は本日を含む直近30 JST 暦日（41日前は除外）', () => {
    expect(filterWithinJstDays(logs, NOW, 30).map((l) => l.id).sort()).toEqual(['d26', 'd5', 'today']);
  });

  it('境界（開始日ちょうど）を含み、その前日を除外する', () => {
    // days=7 → 最古の含有日は JST 06-14。06-14 は含み 06-13 は除外。
    const boundary: ReceptionLog[] = [
      log({ id: 'in', outcome: 'connected', startedAt: '2026-06-14T06:00:00.000Z' }), // JST 06-14 15:00
      log({ id: 'out', outcome: 'connected', startedAt: '2026-06-13T06:00:00.000Z' }), // JST 06-13 15:00
    ];
    expect(filterWithinJstDays(boundary, NOW, 7).map((l) => l.id)).toEqual(['in']);
  });

  it('無効な now は空（graceful empty, #254 と同方針）', () => {
    expect(filterWithinJstDays(logs, new Date('invalid'), 7)).toEqual([]);
  });
});

describe('summarizeExperiencePeriods (#319 期間指定)', () => {
  const withExp = (id: string, startedAt: string, timeToCallMs: number): ReceptionLog => ({
    ...log({ id, outcome: 'connected', startedAt }),
    experience: { timeToCallMs },
  });
  const logs: ReceptionLog[] = [
    withExp('today', '2026-06-20T09:00:00.000Z', 10000), // 30s 以内
    withExp('d5', '2026-06-15T09:00:00.000Z', 45000), // 30s 超
    withExp('d26', '2026-05-25T09:00:00.000Z', 20000), // 30s 以内
  ];

  it('本日/直近7日/直近30日の 3 プリセットを返す', () => {
    const periods = summarizeExperiencePeriods(logs, NOW);
    expect(periods.map((p) => p.key)).toEqual(['today', 'last7d', 'last30d']);
    expect(periods.map((p) => p.label)).toEqual(['本日', '直近7日', '直近30日']);
    expect(periods.map((p) => p.days)).toEqual([1, 7, 30]);
  });

  it('各期間ごとに窓内ログだけで KPI を集計する（30 秒 KPI が期間で変わる）', () => {
    const periods = summarizeExperiencePeriods(logs, NOW);
    const kpiFor = (key: string) => periods.find((p) => p.key === key)?.kpi;
    expect(kpiFor('today')?.total).toBe(1);
    expect(kpiFor('today')?.callStartWithin30s).toEqual({ within: 1, reached: 1 });
    expect(kpiFor('last7d')?.total).toBe(2);
    expect(kpiFor('last7d')?.callStartWithin30s).toEqual({ within: 1, reached: 2 });
    expect(kpiFor('last30d')?.total).toBe(3);
    expect(kpiFor('last30d')?.callStartWithin30s).toEqual({ within: 2, reached: 3 });
  });
});

describe('buildDashboardSummary (#86)', () => {
  it('履歴と端末から概況サマリ全体を組み立てる', () => {
    const logs: ReceptionLog[] = [
      log({ id: 'a', outcome: 'connected', startedAt: '2026-06-20T09:00:00.000Z' }),
      log({ id: 'b', outcome: 'failed', startedAt: '2026-06-20T10:00:00.000Z' }),
    ];
    const devices = fleet({ total: 1, online: 1 });
    const summary = buildDashboardSummary(logs, devices, NOW);
    expect(summary.status).toBe('warning'); // failed あり
    expect(summary.today.total).toBe(2);
    expect(summary.devices).toEqual(devices);
    expect(summary.recentCalls).toHaveLength(2);
    expect(summary.usageCost).toBeNull(); // 未指定なら null
    // 体験 KPI も本日分から集計される (#319)。experience メトリクスは未添付なので 30 秒 KPI は null。
    expect(summary.experience.total).toBe(2);
    expect(summary.experience.completion).toEqual({ connected: 1, total: 2 });
    expect(summary.experience.callStartWithin30sRate).toBeNull();
  });

  it('体験メトリクス付きログから本日の 30 秒 KPI を集計する (#319)', () => {
    const logs: ReceptionLog[] = [
      {
        ...log({ id: 'a', outcome: 'connected', startedAt: '2026-06-20T09:00:00.000Z' }),
        experience: { timeToCallMs: 12000, inputMethod: 'touch' },
      },
      {
        ...log({ id: 'b', outcome: 'timeout', startedAt: '2026-06-20T10:00:00.000Z' }),
        experience: { timeToCallMs: 45000, abandonedAtStep: 'calling' },
      },
    ];
    const summary = buildDashboardSummary(logs, fleet({ total: 1, online: 1 }), NOW);
    expect(summary.experience.measured).toBe(2);
    expect(summary.experience.callStartWithin30s).toEqual({ within: 1, reached: 2 });
    expect(summary.experience.callStartWithin30sRate).toBeCloseTo(0.5);
  });

  it('期間プリセット（本日/直近7日/直近30日）の体験 KPI を含み、experience は本日と一致する (#319)', () => {
    const logs: ReceptionLog[] = [
      { ...log({ id: 'a', outcome: 'connected', startedAt: '2026-06-20T09:00:00.000Z' }), experience: { timeToCallMs: 10000 } },
      { ...log({ id: 'b', outcome: 'connected', startedAt: '2026-06-15T09:00:00.000Z' }), experience: { timeToCallMs: 45000 } },
    ];
    const summary = buildDashboardSummary(logs, fleet({ total: 1, online: 1 }), NOW);
    expect(summary.experiencePeriods.map((p) => p.key)).toEqual(['today', 'last7d', 'last30d']);
    // 本日プリセットは既存の experience（本日集計）と同一値。
    expect(summary.experiencePeriods[0]?.kpi).toEqual(summary.experience);
    expect(summary.experience.total).toBe(1);
    expect(summary.experiencePeriods[1]?.kpi.total).toBe(2);
  });

  it('利用量/コスト概況を受け取ると含める (#86)', () => {
    const usageCost = {
      receptionsThisMonth: 42,
      estimatedSoFar: 1200,
      projectedMonthEnd: 3000,
      currency: 'JPY' as const,
    };
    const summary = buildDashboardSummary([], fleet(), NOW, usageCost);
    expect(summary.usageCost).toEqual(usageCost);
    // 空履歴では体験 KPI もゼロ値（graceful empty）。
    expect(summary.experience.total).toBe(0);
    expect(summary.experience.medianDurationMs).toBeNull();
  });
});
