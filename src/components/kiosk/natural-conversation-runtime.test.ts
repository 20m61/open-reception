import { describe, expect, it } from 'vitest';
import type { EntityDirectory } from '@/domain/voice-stt/entity-resolver';
import type { ReceptionUtteranceExtractor } from '@/domain/reception/slot-proposal';
import { INITIAL, reducer, type FlowData } from './flow-state';
import {
  coalescedExplicitAction,
  resolveNaturalConversationTurn,
  type CommittedReceptionUtterance,
} from './natural-conversation-runtime';

const directory: EntityDirectory = {
  staff: [
    {
      id: 'staff-suzuki',
      displayName: '鈴木 一郎',
      kana: 'すずきいちろう',
      aliases: ['鈴木さん'],
      departmentId: 'sales',
      enabled: true,
      available: true,
      callTargets: [],
      fallbackStaffIds: [],
    },
  ],
  departments: [
    {
      id: 'sales',
      name: '営業部',
      kana: 'えいぎょうぶ',
      displayOrder: 0,
      enabled: true,
    },
  ],
};

const utterance: CommittedReceptionUtterance = {
  text: '営業の鈴木さんに打ち合わせで来ました。張です',
  sttConfidence: 0.95,
};

const completeExtractor: ReceptionUtteranceExtractor = {
  extract: async () => ({
    purpose: { value: 'meeting', confidence: 0.95 },
    targetQuery: { value: '鈴木 一郎', confidence: 0.95 },
    visitorName: { value: '張', confidence: 0.95 },
  }),
};

describe('resolveNaturalConversationTurn (#1077)', () => {
  it('selectingPurpose中の1発話からpurpose/target/nameを取り、intermediate UIなしでconfirmingを計画する', async () => {
    const data: FlowData = { state: 'selectingPurpose' };
    const result = await resolveNaturalConversationTurn({
      data,
      draft: {},
      utterance,
      extractor: completeExtractor,
      directory,
    });

    expect(result.actions).toEqual([
      { type: 'SELECT_PURPOSE', purpose: 'meeting' },
      {
        type: 'SELECT_TARGET',
        target: { type: 'staff', id: 'staff-suzuki', label: '鈴木 一郎' },
      },
      { type: 'SUBMIT_VISITOR_INFO', visitor: { name: '張' } },
    ]);
    expect(result.focus).toEqual({ kind: 'finalConfirmation' });

    const final = reducer(data, { type: 'APPLY_CONVERSATION', actions: result.actions });
    expect(final.state).toBe('confirming');
  });

  it('すでにpurposeがあるselectingTargetではpurposeを聞き直さずtarget+nameだけ進める', async () => {
    const data: FlowData = { state: 'selectingTarget', purpose: 'meeting' };
    const extractor: ReceptionUtteranceExtractor = {
      extract: async () => ({
        targetQuery: { value: '鈴木 一郎', confidence: 0.95 },
        visitorName: { value: '張', confidence: 0.95 },
      }),
    };
    const result = await resolveNaturalConversationTurn({
      data,
      draft: {},
      utterance,
      extractor,
      directory,
    });

    expect(result.actions.map((action) => action.type)).toEqual([
      'SELECT_TARGET',
      'SUBMIT_VISITOR_INFO',
    ]);
    expect(result.focus).toEqual({ kind: 'finalConfirmation' });
  });

  it('unknown targetをextractorが提案しても架空IDを作らずtarget質問を残す', async () => {
    const extractor: ReceptionUtteranceExtractor = {
      extract: async () => ({
        purpose: { value: 'meeting', confidence: 0.95 },
        targetQuery: { value: '存在しない担当者', confidence: 0.99 },
        visitorName: { value: '張', confidence: 0.95 },
      }),
    };
    const result = await resolveNaturalConversationTurn({
      data: { state: 'selectingPurpose' },
      draft: {},
      utterance,
      extractor,
      directory,
    });

    expect(result.actions).toEqual([{ type: 'SELECT_PURPOSE', purpose: 'meeting' }]);
    expect(result.focus).toEqual({ kind: 'collect', slot: 'target' });
  });

  it('低信頼nameは個別repair対象にし、SUBMIT_VISITOR_INFOへ進めない', async () => {
    const extractor: ReceptionUtteranceExtractor = {
      extract: async () => ({
        targetQuery: { value: '鈴木 一郎', confidence: 0.95 },
        visitorName: { value: '張', confidence: 0.2 },
      }),
    };
    const result = await resolveNaturalConversationTurn({
      data: { state: 'selectingTarget', purpose: 'meeting' },
      draft: {},
      utterance,
      extractor,
      directory,
    });

    expect(result.actions).toEqual([
      {
        type: 'SELECT_TARGET',
        target: { type: 'staff', id: 'staff-suzuki', label: '鈴木 一郎' },
      },
    ]);
    expect(result.focus).toEqual({ kind: 'disambiguate', slot: 'visitorName', candidateCount: 1 });
  });
});

describe('coalescedExplicitAction (#1077 repair)', () => {
  it('target訂正時、既存visitorNameを再質問せずSELECT_TARGET+SUBMITを同一batchにする', () => {
    const confirming = reducer(INITIAL, {
      type: 'APPLY_CONVERSATION',
      actions: [
        { type: 'START' },
        { type: 'SELECT_PURPOSE', purpose: 'meeting' },
        { type: 'SELECT_TARGET', target: { type: 'staff', id: 'old', label: '旧担当' } },
        { type: 'SUBMIT_VISITOR_INFO', visitor: { name: '張' } },
      ],
    });
    const selectingTarget = reducer(
      reducer(confirming, { type: 'BACK' }),
      { type: 'BACK' },
    );
    expect(selectingTarget.state).toBe('selectingTarget');

    const planned = coalescedExplicitAction(selectingTarget, {}, {
      type: 'SELECT_TARGET',
      target: { type: 'staff', id: 'staff-suzuki', label: '鈴木 一郎' },
    });

    expect(planned.action).toEqual({
      type: 'APPLY_CONVERSATION',
      actions: [
        {
          type: 'SELECT_TARGET',
          target: { type: 'staff', id: 'staff-suzuki', label: '鈴木 一郎' },
        },
        { type: 'SUBMIT_VISITOR_INFO', visitor: { name: '張' } },
      ],
    });
    expect(reducer(selectingTarget, planned.action).state).toBe('confirming');
  });

  it('presetPurpose付き入口はselectingPurposeを描画せずSTART+SELECT_PURPOSEを一括適用できる', () => {
    const planned = coalescedExplicitAction(INITIAL, {}, {
      type: 'START',
      pendingPurpose: 'meeting',
    });

    expect(planned.action).toEqual({
      type: 'APPLY_CONVERSATION',
      actions: [
        { type: 'START' },
        { type: 'SELECT_PURPOSE', purpose: 'meeting' },
      ],
    });
    expect(reducer(INITIAL, planned.action).state).toBe('selectingTarget');
  });
});
