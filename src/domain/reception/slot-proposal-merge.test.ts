import { describe, expect, it } from 'vitest';
import type { Department } from '@/domain/department/types';
import type { Staff } from '@/domain/staff/types';
import type { EntityDirectory } from '@/domain/voice-stt/entity-resolver';
import type { ConversationDraft } from './conversation-draft';
import { RECEPTION_STATES, type ReceptionState } from './state';
import { mergeSlotProposalIntoDraft, type ReceptionSlotProposal } from './slot-proposal';

/**
 * 自然発話の提案を draft へ足す (#1290、owner の判断 A)。合成データだけを使う。
 *
 * 言い直しを聞き取ったが**使える値にならなかった**（不在の人の名指し・一致なし・下限未満・
 * 長すぎる氏名）ときは、その slot が**まだ開いている画面に限って** `replaceConversationSlot` で
 * 消す。merge だけだと「言及なし」と読まれて前の値が残り、また同じ相手・氏名を復唱するため。
 *
 * 🔴 本番の KioskFlow の相手の経路はまだ `bridgeCommittedTurn` を直接使い、ここを通らない
 * （本番の配線は #1292）。ここで縛るのは domain の契約。
 */
function staff(id: string, displayName: string, kana: string, available = true): Staff {
  return {
    id,
    displayName,
    kana,
    aliases: [],
    departmentId: 'dept-sales',
    enabled: true,
    available,
    callTargets: [],
    fallbackStaffIds: [],
  };
}
const departments: Department[] = [
  { id: 'dept-sales', name: '営業部', kana: 'えいぎょうぶ', displayOrder: 0, enabled: true },
];
const directory: EntityDirectory = {
  staff: [staff('yamada', '山田', 'やまだ'), staff('suzuki', '鈴木', 'すずき', false)],
  departments,
};
const options = { directory, sttConfidence: 0.95 };

const previousTarget: ConversationDraft = {
  target: {
    kind: 'resolved',
    value: { type: 'staff', id: 'yamada', label: '山田', sublabel: '営業部' },
    evidence: { source: 'voice', certainty: 'high' },
  },
};
const previousName: ConversationDraft = {
  visitorName: { kind: 'resolved', value: '受付 太郎', evidence: { source: 'voice', certainty: 'high' } },
};

const say = (proposal: ReceptionSlotProposal, draft: ConversationDraft, state: ReceptionState) =>
  mergeSlotProposalIntoDraft(draft, proposal, options, state);
const target = (value: string) => ({ targetQuery: { value, confidence: 0.95 } });

describe('相手の言い直しが使える値にならなかったら、開いている slot を消す', () => {
  it.each([
    ['不在の人の名指し', '鈴木'],
    ['誰とも一致しない', '高橋'],
  ])('%s → 前の相手を消す（selectingTarget）', (_, query) => {
    expect(say(target(query), previousTarget, 'selectingTarget').target).toBeUndefined();
  });

  it('STT の下限未満（相手が候補にならない）も消す', () => {
    const draft = mergeSlotProposalIntoDraft(previousTarget, target('高橋'), { directory, sttConfidence: 0.1 }, 'selectingTarget');
    expect(draft.target).toBeUndefined();
  });

  it('通り過ぎた画面（inputVisitorInfo で相手を言った）では消さない（状態機械が受け取り済み）', () => {
    expect(say(target('鈴木'), previousTarget, 'inputVisitorInfo').target).toEqual(previousTarget.target);
  });

  it('相手に触れていない発話（氏名だけ）では、相手を消さない', () => {
    const draft = say({ visitorName: { value: '受付 花子', confidence: 0.95 } }, previousTarget, 'selectingTarget');
    expect(draft.target).toEqual(previousTarget.target);
  });

  it('使える言い直しなら置き換える（下界: 消すだけの実装では通らない）', () => {
    const draft = say(target('山田'), {}, 'selectingTarget');
    expect(draft.target).toMatchObject({ kind: 'resolved', value: { id: 'yamada' } });
  });
});

describe('氏名の言い直しが使える値にならなかったら、開いている slot を消す', () => {
  it('上限を超える・名乗りの確信度が下限未満なら、前の氏名を消す', () => {
    expect(say({ visitorName: { value: 'あ'.repeat(51), confidence: 0.95 } }, previousName, 'inputVisitorInfo').visitorName).toBeUndefined();
    expect(say({ visitorName: { value: '受付', confidence: 0.1 } }, previousName, 'inputVisitorInfo').visitorName).toBeUndefined();
  });

  it('確認画面（通り過ぎた）では消さない', () => {
    expect(say({ visitorName: { value: 'あ'.repeat(51), confidence: 0.95 } }, previousName, 'confirming').visitorName).toEqual(
      previousName.visitorName,
    );
  });

  it('使える言い直しなら置き換える', () => {
    const draft = say({ visitorName: { value: '受付 花子', confidence: 0.95 } }, previousName, 'inputVisitorInfo');
    expect(draft.visitorName).toMatchObject({ kind: 'resolved', value: '受付 花子' });
  });
});

describe('受付途中の 4 状態以外では draft を持たない', () => {
  it('どの状態でも、開いていない slot は消さないし足しもしない', () => {
    for (const state of RECEPTION_STATES.filter(
      (s) => !['selectingPurpose', 'selectingTarget', 'inputVisitorInfo', 'confirming'].includes(s),
    )) {
      expect(say(target('鈴木'), previousTarget, state).target, state).toEqual(previousTarget.target);
    }
  });
});
