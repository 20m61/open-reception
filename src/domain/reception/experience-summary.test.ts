import { describe, expect, it } from 'vitest';
import type { ReceptionExperience, ReceptionLog } from './log';
import {
  EXPERIENCE_STEP_ORDER,
  summarizeExperience,
  emptyExperienceKpi,
} from './experience-summary';

function log(
  over: Partial<ReceptionLog> & Pick<ReceptionLog, 'id' | 'outcome'>,
  experience?: ReceptionExperience,
): ReceptionLog {
  return {
    receptionId: `rcp-${over.id}`,
    kioskId: 'kiosk-1',
    fallbackUsed: false,
    startedAt: '2026-07-11T00:00:00.000Z',
    endedAt: '2026-07-11T00:00:10.000Z',
    durationMs: 10000,
    createdAt: '2026-07-11T00:00:10.000Z',
    ...over,
    ...(experience ? { experience } : {}),
  };
}

describe('summarizeExperience (#319)', () => {
  it('空履歴は全指標ゼロ／null（graceful empty）', () => {
    const kpi = summarizeExperience([]);
    expect(kpi).toEqual(emptyExperienceKpi());
    expect(kpi.callStartWithin30sRate).toBeNull();
    expect(kpi.completionRate).toBeNull();
    expect(kpi.medianDurationMs).toBeNull();
  });

  it('30 秒以内呼び出し開始率: 分子=timeToCallMs<=30000, 分母=呼び出し到達（timeToCallMs あり）', () => {
    const logs = [
      log({ id: 'a', outcome: 'connected' }, { timeToCallMs: 12000 }), // within
      log({ id: 'b', outcome: 'connected' }, { timeToCallMs: 30000 }), // within（境界含む）
      log({ id: 'c', outcome: 'timeout' }, { timeToCallMs: 45000 }), // over
      log({ id: 'd', outcome: 'failed' }, {}), // 呼び出し未到達（分母外）
    ];
    const kpi = summarizeExperience(logs);
    expect(kpi.callStartWithin30s).toEqual({ within: 2, reached: 3 });
    expect(kpi.callStartWithin30sRate).toBeCloseTo(2 / 3);
  });

  it('完遂率は全ログの connected 比率（experience 有無に依らず outcome から算出）', () => {
    const logs = [
      log({ id: 'a', outcome: 'connected' }),
      log({ id: 'b', outcome: 'connected' }, { timeToCallMs: 5000 }),
      log({ id: 'c', outcome: 'timeout' }),
      log({ id: 'd', outcome: 'cancelled' }),
    ];
    const kpi = summarizeExperience(logs);
    expect(kpi.completion).toEqual({ connected: 2, total: 4 });
    expect(kpi.completionRate).toBeCloseTo(0.5);
  });

  it('中央値所要は durationMs の中央値（偶数個は平均）', () => {
    const logs = [
      log({ id: 'a', outcome: 'connected', durationMs: 1000 }),
      log({ id: 'b', outcome: 'connected', durationMs: 3000 }),
      log({ id: 'c', outcome: 'connected', durationMs: 5000 }),
    ];
    expect(summarizeExperience(logs).medianDurationMs).toBe(3000);
    const even = [
      log({ id: 'a', outcome: 'connected', durationMs: 1000 }),
      log({ id: 'b', outcome: 'connected', durationMs: 3000 }),
    ];
    expect(summarizeExperience(even).medianDurationMs).toBe(2000);
  });

  it('ファネルは到達数を単調に数え、離脱ステップを特定できる', () => {
    const logs = [
      // 完遂（connected まで到達）
      log({ id: 'a', outcome: 'connected' }, {
        stepDurations: { selectingPurpose: 1, selectingTarget: 1, inputVisitorInfo: 1, confirming: 1, calling: 1, connected: 1 },
      }),
      // selectingTarget で離脱
      log({ id: 'b', outcome: 'cancelled' }, {
        stepDurations: { selectingPurpose: 1, selectingTarget: 1 },
        abandonedAtStep: 'selectingTarget',
      }),
      // confirming で離脱
      log({ id: 'c', outcome: 'cancelled' }, {
        stepDurations: { selectingPurpose: 1, selectingTarget: 1, inputVisitorInfo: 1, confirming: 1 },
        abandonedAtStep: 'confirming',
      }),
    ];
    const kpi = summarizeExperience(logs);
    const byStep = Object.fromEntries(kpi.funnel.map((f) => [f.step, f]));
    // 3 件とも selectingPurpose/selectingTarget に到達
    expect(byStep.selectingPurpose?.reached).toBe(3);
    expect(byStep.selectingTarget?.reached).toBe(3);
    // inputVisitorInfo 以降は a と c の 2 件
    expect(byStep.inputVisitorInfo?.reached).toBe(2);
    expect(byStep.confirming?.reached).toBe(2);
    // calling/connected は a の 1 件
    expect(byStep.calling?.reached).toBe(1);
    expect(byStep.connected?.reached).toBe(1);
    // 離脱ステップ
    expect(byStep.selectingTarget?.abandoned).toBe(1);
    expect(byStep.confirming?.abandoned).toBe(1);
    // funnel はステップ順
    expect(kpi.funnel.map((f) => f.step)).toEqual([...EXPERIENCE_STEP_ORDER]);
  });

  it('入力手段の利用数を集計する（測定済みのみ）', () => {
    const logs = [
      log({ id: 'a', outcome: 'connected' }, { inputMethod: 'touch' }),
      log({ id: 'b', outcome: 'connected' }, { inputMethod: 'stt' }),
      log({ id: 'c', outcome: 'connected' }, { inputMethod: 'stt' }),
      log({ id: 'd', outcome: 'connected' }), // experience なし → 数えない
    ];
    const kpi = summarizeExperience(logs);
    expect(kpi.inputMethods).toEqual({ touch: 1, stt: 2, chat: 0, qr: 0 });
    expect(kpi.measured).toBe(3);
    expect(kpi.total).toBe(4);
  });
});
