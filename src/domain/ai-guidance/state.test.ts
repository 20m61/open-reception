import { describe, expect, it } from 'vitest';
import {
  AI_GUIDANCE_EVENTS,
  type AiGuidanceEvent,
  escalationReasonFor,
  isAiGuidanceState,
  isEscalationEvent,
  isTerminal,
  transition,
  transitionOrThrow,
} from './state';

const ESCALATION_EVENTS: AiGuidanceEvent[] = [
  'REQUEST_HUMAN',
  'LOW_CONFIDENCE',
  'TIMEOUT',
  'NG_WORD',
  'REPEATED_FAILURE',
];

describe('ai-guidance state machine', () => {
  it('全エスカレーション条件は guiding から handoff_requested へ倒れる（即時実行しない）', () => {
    for (const event of ESCALATION_EVENTS) {
      expect(transition('guiding', event)).toBe('handoff_requested');
    }
  });

  it('AI が guiding から直接 handed_off（実行完了）へ飛ぶ遷移は存在しない', () => {
    // 即時呼び出し禁止の保証: どのイベントでも guiding→handed_off は起きない。
    for (const event of AI_GUIDANCE_EVENTS) {
      expect(transition('guiding', event)).not.toBe('handed_off');
    }
  });

  it('引き継ぎ確定で handed_off、失敗で failed に進む', () => {
    expect(transition('handoff_requested', 'HANDOFF_CONFIRMED')).toBe('handed_off');
    expect(transition('handoff_requested', 'HANDOFF_FAILED')).toBe('failed');
  });

  it('引き継ぎ失敗後はフォールバックで終端（handed_off）へ戻す', () => {
    expect(transition('failed', 'FALLBACK')).toBe('handed_off');
  });

  it('RESET はどの状態からでも guiding に戻す', () => {
    for (const state of ['guiding', 'handoff_requested', 'handed_off', 'failed'] as const) {
      expect(transition(state, 'RESET')).toBe('guiding');
    }
  });

  it('不正遷移は null を返す', () => {
    expect(transition('handed_off', 'HANDOFF_CONFIRMED')).toBeNull();
    expect(transition('guiding', 'HANDOFF_CONFIRMED')).toBeNull();
    expect(transition('handoff_requested', 'FALLBACK')).toBeNull();
  });

  it('transitionOrThrow は不正遷移で例外を投げる', () => {
    expect(() => transitionOrThrow('handed_off', 'HANDOFF_FAILED')).toThrow(/Invalid ai-guidance transition/);
    expect(transitionOrThrow('guiding', 'REQUEST_HUMAN')).toBe('handoff_requested');
  });

  it('handed_off は終端状態', () => {
    expect(isTerminal('handed_off')).toBe(true);
    expect(isTerminal('guiding')).toBe(false);
    expect(isTerminal('handoff_requested')).toBe(false);
    expect(isTerminal('failed')).toBe(false);
  });

  it('escalationReasonFor はエスカレーションイベントを理由へ写像する', () => {
    expect(escalationReasonFor('REQUEST_HUMAN')).toBe('user_request');
    expect(escalationReasonFor('LOW_CONFIDENCE')).toBe('low_confidence');
    expect(escalationReasonFor('TIMEOUT')).toBe('timeout');
    expect(escalationReasonFor('NG_WORD')).toBe('ng_word');
    expect(escalationReasonFor('REPEATED_FAILURE')).toBe('repeated_failure');
    expect(escalationReasonFor('HANDOFF_CONFIRMED')).toBeNull();
  });

  it('isEscalationEvent はエスカレーション系のみ true', () => {
    for (const event of ESCALATION_EVENTS) {
      expect(isEscalationEvent(event)).toBe(true);
    }
    expect(isEscalationEvent('HANDOFF_CONFIRMED')).toBe(false);
    expect(isEscalationEvent('RESET')).toBe(false);
  });

  it('isAiGuidanceState は既知の状態のみ受け付ける', () => {
    expect(isAiGuidanceState('guiding')).toBe(true);
    expect(isAiGuidanceState('unknown')).toBe(false);
    expect(isAiGuidanceState(42)).toBe(false);
  });
});
