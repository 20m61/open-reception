import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ESCALATION_POLICY,
  type GuidanceTurnSignal,
  applyTurn,
  createAiGuidanceSession,
  dispatch,
  evaluateEscalation,
  isIdleTimeout,
} from './session';

const T0 = '2026-06-20T00:00:00.000Z';
const T1 = '2026-06-20T00:00:10.000Z';

function newSession() {
  return createAiGuidanceSession({ id: 's1', kioskId: 'k1', now: T0 });
}

const OK_SIGNAL: GuidanceTurnSignal = {
  confidence: 0.9,
  resolved: true,
  ngWordDetected: false,
  userRequestedHuman: false,
};

describe('ai-guidance session', () => {
  it('新規セッションは guiding・PII/会話を持たない', () => {
    const s = newSession();
    expect(s.state).toBe('guiding');
    expect(s.repeatedFailures).toBe(0);
    expect(s.policy).toEqual(DEFAULT_ESCALATION_POLICY);
    // 会話・PII フィールドが型に存在しないことの担保（キーが無い）。
    expect(Object.keys(s)).not.toContain('visitor');
    expect(Object.keys(s)).not.toContain('utterance');
  });

  describe('evaluateEscalation（各エスカレーション条件）', () => {
    it('ユーザー要求を最優先する', () => {
      const d = evaluateEscalation(newSession(), { ...OK_SIGNAL, userRequestedHuman: true });
      expect(d).toEqual({ event: 'REQUEST_HUMAN', reason: 'user_request' });
    });

    it('NG ワード検知でエスカレーション', () => {
      const d = evaluateEscalation(newSession(), { ...OK_SIGNAL, ngWordDetected: true });
      expect(d).toEqual({ event: 'NG_WORD', reason: 'ng_word' });
    });

    it('低信頼でエスカレーション', () => {
      const d = evaluateEscalation(newSession(), { ...OK_SIGNAL, confidence: 0.3 });
      expect(d).toEqual({ event: 'LOW_CONFIDENCE', reason: 'low_confidence' });
    });

    it('連続失敗が上限に達したらエスカレーション', () => {
      // maxRepeatedFailures=2。すでに 1 回失敗していて今回も未解決 → 2 回で発火。
      const s = { ...newSession(), repeatedFailures: 1 };
      const d = evaluateEscalation(s, { ...OK_SIGNAL, resolved: false });
      expect(d).toEqual({ event: 'REPEATED_FAILURE', reason: 'repeated_failure' });
    });

    it('1 回の未解決ではまだエスカレーションしない', () => {
      const d = evaluateEscalation(newSession(), { ...OK_SIGNAL, resolved: false });
      expect(d.event).toBeNull();
    });

    it('優先順位: ユーザー要求 > NG ワード > 低信頼', () => {
      const d = evaluateEscalation(newSession(), {
        confidence: 0.1,
        resolved: false,
        ngWordDetected: true,
        userRequestedHuman: true,
      });
      expect(d.event).toBe('REQUEST_HUMAN');
    });

    it('正常応答ではエスカレーションしない', () => {
      expect(evaluateEscalation(newSession(), OK_SIGNAL).event).toBeNull();
    });
  });

  describe('applyTurn', () => {
    it('正常応答では guiding のまま連続失敗を 0 にリセットする', () => {
      const s = { ...newSession(), repeatedFailures: 1 };
      const next = applyTurn(s, OK_SIGNAL, T1);
      expect(next.state).toBe('guiding');
      expect(next.repeatedFailures).toBe(0);
      expect(next.lastInteractionAt).toBe(T1);
    });

    it('未解決で連続失敗カウントを進める', () => {
      const next = applyTurn(newSession(), { ...OK_SIGNAL, resolved: false }, T1);
      expect(next.state).toBe('guiding');
      expect(next.repeatedFailures).toBe(1);
    });

    it('エスカレーション時は handoff_requested へ進み理由を記録する（即時実行しない）', () => {
      const next = applyTurn(newSession(), { ...OK_SIGNAL, userRequestedHuman: true }, T1);
      expect(next.state).toBe('handoff_requested');
      expect(next.escalationReason).toBe('user_request');
    });

    it('guiding 以外ではターンを無視する（引き継ぎ後は人間管轄）', () => {
      const escalated = applyTurn(newSession(), { ...OK_SIGNAL, ngWordDetected: true }, T1);
      const again = applyTurn(escalated, OK_SIGNAL, T1);
      expect(again).toBe(escalated);
    });
  });

  describe('isIdleTimeout', () => {
    it('閾値超過でタイムアウト判定', () => {
      const s = newSession(); // idleTimeoutMs=30000
      expect(isIdleTimeout(s, '2026-06-20T00:00:31.000Z')).toBe(true);
      expect(isIdleTimeout(s, '2026-06-20T00:00:10.000Z')).toBe(false);
    });
  });

  describe('dispatch', () => {
    it('引き継ぎ確定で handed_off へ', () => {
      const s = applyTurn(newSession(), { ...OK_SIGNAL, userRequestedHuman: true }, T1);
      const done = dispatch(s, 'HANDOFF_CONFIRMED', T1);
      expect(done.state).toBe('handed_off');
    });

    it('引き継ぎ失敗→フォールバックで終端へ戻す', () => {
      const s = applyTurn(newSession(), { ...OK_SIGNAL, ngWordDetected: true }, T1);
      const failed = dispatch(s, 'HANDOFF_FAILED', T1);
      expect(failed.state).toBe('failed');
      const fellBack = dispatch(failed, 'FALLBACK', T1);
      expect(fellBack.state).toBe('handed_off');
    });

    it('不正遷移は状態を変えずそのまま返す', () => {
      const s = newSession();
      expect(dispatch(s, 'HANDOFF_CONFIRMED', T1)).toBe(s);
    });
  });
});
