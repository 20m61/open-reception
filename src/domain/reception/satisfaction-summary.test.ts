import { describe, expect, it } from 'vitest';
import type { FeedbackReasonCode, ReceptionLog, SatisfactionRating } from './log';
import { emptySatisfactionSummary, summarizeSatisfaction } from './satisfaction-summary';

function log(
  over: Partial<ReceptionLog> & Pick<ReceptionLog, 'id' | 'outcome'>,
  rating?: SatisfactionRating,
  reasonCodes?: FeedbackReasonCode[],
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
    ...(rating ? { satisfactionRating: rating } : {}),
    ...(reasonCodes ? { feedbackReasonCodes: reasonCodes } : {}),
  };
}

describe('summarizeSatisfaction (#320)', () => {
  it('空履歴は全指標ゼロ（graceful empty）', () => {
    const summary = summarizeSatisfaction([]);
    expect(summary).toEqual(emptySatisfactionSummary());
    expect(summary.total).toBe(0);
    expect(summary.responded).toBe(0);
  });

  it('未評価のログは分母（total）には入るが responded/byRating には入らない', () => {
    const logs = [log({ id: 'a', outcome: 'connected' })];
    const summary = summarizeSatisfaction(logs);
    expect(summary.total).toBe(1);
    expect(summary.responded).toBe(0);
    expect(summary.byRating).toEqual({ happy: 0, neutral: 0, unhappy: 0 });
  });

  it('評価値別に集計する', () => {
    const logs = [
      log({ id: 'a', outcome: 'connected' }, 'happy'),
      log({ id: 'b', outcome: 'connected' }, 'happy'),
      log({ id: 'c', outcome: 'timeout' }, 'neutral'),
      log({ id: 'd', outcome: 'failed' }, 'unhappy'),
      log({ id: 'e', outcome: 'failed' }), // 未評価
    ];
    const summary = summarizeSatisfaction(logs);
    expect(summary.total).toBe(5);
    expect(summary.responded).toBe(4);
    expect(summary.byRating).toEqual({ happy: 2, neutral: 1, unhappy: 1 });
  });

  it('終端状態（outcome）別・評価値別に内訳を集計する', () => {
    const logs = [
      log({ id: 'a', outcome: 'connected' }, 'happy'),
      log({ id: 'b', outcome: 'timeout' }, 'unhappy'),
      log({ id: 'c', outcome: 'failed' }, 'unhappy'),
    ];
    const summary = summarizeSatisfaction(logs);
    expect(summary.byOutcome.connected).toEqual({ happy: 1, neutral: 0, unhappy: 0 });
    expect(summary.byOutcome.timeout).toEqual({ happy: 0, neutral: 0, unhappy: 1 });
    expect(summary.byOutcome.failed).toEqual({ happy: 0, neutral: 0, unhappy: 1 });
    expect(summary.byOutcome.cancelled).toEqual({ happy: 0, neutral: 0, unhappy: 0 });
  });

  it('理由コード別に件数を集計する（複数選択可のため合計が responded と一致しないことがある）', () => {
    const logs = [
      log({ id: 'a', outcome: 'timeout' }, 'unhappy', ['waitTooLong', 'hardToOperate']),
      log({ id: 'b', outcome: 'failed' }, 'unhappy', ['waitTooLong']),
      log({ id: 'c', outcome: 'connected' }, 'happy'), // 理由コードなし
    ];
    const summary = summarizeSatisfaction(logs);
    expect(summary.byReasonCode.waitTooLong).toBe(2);
    expect(summary.byReasonCode.hardToOperate).toBe(1);
    expect(summary.byReasonCode.staffUnavailable).toBe(0);
    expect(summary.byReasonCode.other).toBe(0);
  });
});
