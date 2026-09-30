import { describe, expect, it } from 'vitest';
import {
  isDraftReadyForFinalConfirmation,
  materializationActionsForDraft,
  mergeConversationDraft,
  nextConversationFocus,
  replaceConversationSlot,
  type ConversationDraft,
  type ConversationSlot,
  type ConversationTarget,
} from './conversation-draft';
import type { ReceptionPurposeId } from './session';

const confirmed = <T>(
  value: T,
  source: 'touch' | 'voice' | 'qr' | 'reservation' = 'touch',
): ConversationSlot<T> => ({
  kind: 'resolved',
  value,
  evidence: { source, certainty: 'confirmed' },
});

const high = <T>(value: T): ConversationSlot<T> => ({
  kind: 'resolved',
  value,
  evidence: { source: 'voice', certainty: 'high' },
});

const ambiguous = <T>(...candidates: T[]): ConversationSlot<T> => ({
  kind: 'ambiguous',
  candidates,
  evidence: { source: 'voice', certainty: 'ambiguous' },
});

const suzuki: ConversationTarget = {
  type: 'staff',
  id: 'staff-suzuki',
  label: '鈴木 一郎',
  sublabel: '営業部',
};

const sato: ConversationTarget = {
  type: 'staff',
  id: 'staff-sato',
  label: '佐藤 花子',
  sublabel: '営業部',
};

const completeDraft = (): ConversationDraft => ({
  purpose: high<ReceptionPurposeId>('meeting'),
  target: high(suzuki),
  visitorName: high('張'),
});

describe('nextConversationFocus (#1077 / #1079)', () => {
  it('「担当者を呼ぶ」の既定は、何も無ければtargetを最初の会話焦点にする', () => {
    expect(nextConversationFocus({}, { voiceAvailable: true })).toEqual({
      kind: 'collect',
      slot: 'target',
    });
  });

  it('targetが既に取れていれば同じ質問をせずvisitorNameへ進む', () => {
    expect(
      nextConversationFocus(
        { target: high(suzuki) },
        { voiceAvailable: true },
      ),
    ).toEqual({ kind: 'collect', slot: 'visitorName' });
  });

  it('targetが曖昧なら、別の不足slotを増やす前に候補選択でrepairする', () => {
    expect(
      nextConversationFocus(
        { target: ambiguous(suzuki, sato) },
        { voiceAvailable: true },
      ),
    ).toEqual({ kind: 'disambiguate', slot: 'target', candidateCount: 2 });
  });

  it('required slotsが全部resolvedならfinal confirmationだけを次にする', () => {
    expect(nextConversationFocus(completeDraft(), { voiceAvailable: true })).toEqual({
      kind: 'finalConfirmation',
    });
  });

  it('visitorNameだけが足りずSTT unavailableならkeyboardではなくassistanceへ', () => {
    const draft: ConversationDraft = {
      purpose: confirmed('meeting'),
      target: confirmed(suzuki),
    };
    expect(
      nextConversationFocus(draft, {
        voiceAvailable: false,
        assistanceAvailable: true,
      }),
    ).toEqual({ kind: 'assistance', slot: 'visitorName' });
  });

  it('有人支援も無いなら虚偽のCTAを作らずblockedを返す', () => {
    const draft: ConversationDraft = {
      purpose: confirmed('meeting'),
      target: confirmed(suzuki),
    };
    expect(nextConversationFocus(draft, { voiceAvailable: false })).toEqual({
      kind: 'blocked',
      slot: 'visitorName',
    });
  });

  it('entry intentに応じてfocus順を差し替えられる', () => {
    expect(
      nextConversationFocus(
        {},
        {
          voiceAvailable: true,
          focusOrder: ['purpose', 'target', 'visitorName'],
        },
      ),
    ).toEqual({ kind: 'collect', slot: 'purpose' });
  });
});

describe('multi-slot merge / repair (#1077)', () => {
  it('1発話からpurpose + target + visitorNameを同時に取り込める', () => {
    const merged = mergeConversationDraft({}, completeDraft());
    expect(isDraftReadyForFinalConfirmation(merged)).toBe(true);
  });

  it('タッチでconfirmed済みのtargetを後続のvoice highで勝手に上書きしない', () => {
    const merged = mergeConversationDraft(
      { target: confirmed(suzuki) },
      { target: high(sato) },
    );
    expect(merged.target).toEqual(confirmed(suzuki));
  });

  it('voice ambiguousは後続の明示touchでresolvedにできる', () => {
    const merged = mergeConversationDraft(
      { target: ambiguous(suzuki, sato) },
      { target: confirmed(sato) },
    );
    expect(merged.target).toEqual(confirmed(sato));
  });

  it('明示訂正はtargetだけを置き換え、purpose/nameを失わない', () => {
    const before = completeDraft();
    const after = replaceConversationSlot(before, 'target', confirmed(sato));

    expect(after.target).toEqual(confirmed(sato));
    expect(after.purpose).toEqual(before.purpose);
    expect(after.visitorName).toEqual(before.visitorName);
  });

  it('slotを消して再質問対象へ戻しても他slotは維持する', () => {
    const before = completeDraft();
    const after = replaceConversationSlot(before, 'visitorName', undefined);

    expect(after.visitorName).toBeUndefined();
    expect(after.target).toEqual(before.target);
    expect(after.purpose).toEqual(before.purpose);
    expect(nextConversationFocus(after, { voiceAvailable: true })).toEqual({
      kind: 'collect',
      slot: 'visitorName',
    });
  });
});

describe('materializationActionsForDraft (#1079)', () => {
  it('一発話で必要slotが揃えばidleからconfirming手前まで内部stateをcoalesceできる', () => {
    expect(materializationActionsForDraft('idle', completeDraft())).toEqual([
      { type: 'START' },
      { type: 'SELECT_PURPOSE', purpose: 'meeting' },
      { type: 'SELECT_TARGET', target: suzuki },
      { type: 'SUBMIT_VISITOR_INFO', visitor: { name: '張' } },
    ]);
  });

  it('state順より先にtarget/nameを得ても、purposeが無ければ捨てずselectingPurposeで止まる', () => {
    const draft: ConversationDraft = {
      target: high(suzuki),
      visitorName: high('張'),
    };

    expect(materializationActionsForDraft('idle', draft)).toEqual([{ type: 'START' }]);
    expect(draft.target).toEqual(high(suzuki));
    expect(draft.visitorName).toEqual(high('張'));
  });

  it('selectingTargetからなら取得済みtarget/nameを連続適用してconfirmingへ進める', () => {
    const draft: ConversationDraft = {
      target: confirmed(suzuki),
      visitorName: high('張'),
    };

    expect(materializationActionsForDraft('selectingTarget', draft)).toEqual([
      { type: 'SELECT_TARGET', target: suzuki },
      { type: 'SUBMIT_VISITOR_INFO', visitor: { name: '張' } },
    ]);
  });

  it('companyはresolvedなら保持するが必須ではない', () => {
    const draft = {
      ...completeDraft(),
      company: high('株式会社サンプル'),
    } satisfies ConversationDraft;

    expect(materializationActionsForDraft('inputVisitorInfo', draft)).toEqual([
      {
        type: 'SUBMIT_VISITOR_INFO',
        visitor: { name: '張', company: '株式会社サンプル' },
      },
    ]);
  });

  it('ambiguousなslotはstateへmaterializeしない', () => {
    const draft: ConversationDraft = {
      purpose: confirmed('meeting'),
      target: ambiguous(suzuki, sato),
      visitorName: high('張'),
    };

    expect(materializationActionsForDraft('selectingPurpose', draft)).toEqual([
      { type: 'SELECT_PURPOSE', purpose: 'meeting' },
    ]);
  });

  it('plannerは呼び出し確定CONFIRMを絶対に生成しない', () => {
    const actions = materializationActionsForDraft('idle', completeDraft());
    expect(actions.map((action) => action.type)).not.toContain('CONFIRM');
    expect(materializationActionsForDraft('confirming', completeDraft())).toEqual([]);
  });
});
