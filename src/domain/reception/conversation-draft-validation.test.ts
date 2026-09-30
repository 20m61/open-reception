import { describe, expect, it } from 'vitest';
import {
  isDraftReadyForFinalConfirmation,
  materializationActionsForDraft,
  nextConversationFocus,
  type ConversationDraft,
  type ConversationSlot,
  type ConversationTarget,
} from './conversation-draft';

const high = <T>(value: T): ConversationSlot<T> => ({
  kind: 'resolved',
  value,
  evidence: { source: 'voice', certainty: 'high' },
});

const target: ConversationTarget = {
  type: 'staff',
  id: 'staff-suzuki',
  label: '鈴木 一郎',
};

function base(): ConversationDraft {
  return {
    purpose: high('meeting'),
    target: high(target),
    visitorName: high('張'),
  };
}

describe('conversation draft semantic validation (#1079)', () => {
  it('空白だけのvisitorNameをfinal confirmation-readyとみなさない', () => {
    const draft: ConversationDraft = { ...base(), visitorName: high('   ') };
    expect(isDraftReadyForFinalConfirmation(draft)).toBe(false);
    expect(nextConversationFocus(draft, { voiceAvailable: true })).toEqual({
      kind: 'collect',
      slot: 'visitorName',
    });
  });

  it('空ID/空labelのtargetを取得済み扱いしない', () => {
    const draft: ConversationDraft = {
      ...base(),
      target: high({ type: 'staff', id: ' ', label: ' ' }),
    };
    expect(isDraftReadyForFinalConfirmation(draft)).toBe(false);
    expect(nextConversationFocus(draft, { voiceAvailable: true })).toEqual({
      kind: 'collect',
      slot: 'target',
    });
  });

  it('空白氏名をSUBMIT_VISITOR_INFOとしてmaterializeしない', () => {
    const draft: ConversationDraft = {
      target: high(target),
      visitorName: high('   '),
    };
    expect(materializationActionsForDraft('selectingTarget', draft)).toEqual([
      { type: 'SELECT_TARGET', target },
    ]);
  });

  it('空候補しかないambiguous visitorNameは候補選択を出さず再収集する', () => {
    const draft: ConversationDraft = {
      ...base(),
      visitorName: {
        kind: 'ambiguous',
        candidates: [' ', ''],
        evidence: { source: 'voice', certainty: 'ambiguous' },
      },
    };
    expect(nextConversationFocus(draft, { voiceAvailable: true })).toEqual({
      kind: 'collect',
      slot: 'visitorName',
    });
  });
});
