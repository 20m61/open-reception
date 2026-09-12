import type { EntityDirectory } from '@/domain/voice-stt/entity-resolver';
import {
  materializationActionsForDraft,
  mergeConversationDraft,
  nextConversationFocus,
  replaceConversationSlot,
  type ConversationDraft,
  type ConversationFocus,
  type ConversationMaterializationAction,
  type ConversationSlot,
  type ConversationTarget,
} from '@/domain/reception/conversation-draft';
import {
  resolveReceptionSlotProposal,
  type ReceptionUtteranceExtractor,
} from '@/domain/reception/slot-proposal';
import type { ReceptionPurposeId, VisitorInfo } from '@/domain/reception/session';
import { reducer, type Action, type FlowData, type Target } from './flow-state';

export type CommittedReceptionUtterance = {
  text: string;
  sttConfidence: number;
};

function confirmed<T>(value: T): ConversationSlot<T> {
  return {
    kind: 'resolved',
    value,
    evidence: { source: 'touch', certainty: 'confirmed' },
  };
}

/**
 * 既存 FlowData から draft の「欠けているところだけ」を補う。
 *
 * 既存 draft に voice/high 等の provenance がある場合は上書きしない。
 * これは reducer state と draft の同期用で、来訪者の明示確認を捏造しないため。
 */
export function seedConversationDraftFromFlowData(
  draft: ConversationDraft,
  data: FlowData,
): ConversationDraft {
  let next = draft;
  if (!next.purpose && data.purpose) {
    next = { ...next, purpose: confirmed(data.purpose) };
  }
  if (!next.target && data.target) {
    next = { ...next, target: confirmed(data.target) };
  }
  if (!next.visitorName && data.visitor?.name.trim()) {
    next = { ...next, visitorName: confirmed(data.visitor.name.trim()) };
  }
  if (!next.company && data.visitor?.company?.trim()) {
    next = { ...next, company: confirmed(data.visitor.company.trim()) };
  }
  return next;
}

/**
 * 来訪者の明示タッチ/入力アクションを draft に反映する。
 * 同順位の既存値を merge で残さず `replace` するのは「訂正」を尊重するため。
 */
export function draftAfterExplicitAction(
  draft: ConversationDraft,
  action: Action,
): ConversationDraft {
  switch (action.type) {
    case 'START':
      return action.pendingPurpose
        ? replaceConversationSlot(draft, 'purpose', confirmed(action.pendingPurpose))
        : draft;
    case 'SELECT_PURPOSE': {
      // purpose変更時は reducer と同じく target を作り直す。visitorName は保持する。
      const withPurpose = replaceConversationSlot(draft, 'purpose', confirmed(action.purpose));
      return replaceConversationSlot(withPurpose, 'target', undefined);
    }
    case 'SELECT_TARGET':
      return replaceConversationSlot(draft, 'target', confirmed(action.target));
    case 'SUBMIT_VISITOR_INFO': {
      let next = replaceConversationSlot(draft, 'visitorName', confirmed(action.visitor.name.trim()));
      const company = action.visitor.company?.trim();
      next = replaceConversationSlot(next, 'company', company ? confirmed(company) : undefined);
      return next;
    }
    case 'RESET':
    case 'CANCEL':
      return {};
    default:
      return draft;
  }
}

function explicitForwardMaterialization(action: Action): ConversationMaterializationAction | null {
  switch (action.type) {
    case 'START':
      return { type: 'START' };
    case 'SELECT_PURPOSE':
      return { type: 'SELECT_PURPOSE', purpose: action.purpose };
    case 'SELECT_TARGET':
      return { type: 'SELECT_TARGET', target: action.target };
    case 'SUBMIT_VISITOR_INFO':
      return { type: 'SUBMIT_VISITOR_INFO', visitor: action.visitor };
    default:
      return null;
  }
}

/**
 * 明示操作の直後に、すでに draft にある後続slotを再質問せず一緒にmaterializeする。
 *
 * 例: confirmingからtarget訂正で戻り、新しいtargetを選んだ時、visitorNameが保持済みなら
 * `SELECT_TARGET + SUBMIT_VISITOR_INFO` を1 batchにし、氏名をもう一度聞かない。
 */
export function coalescedExplicitAction(
  data: FlowData,
  draft: ConversationDraft,
  action: Action,
): { draft: ConversationDraft; action: Action } {
  const seeded = seedConversationDraftFromFlowData(draft, data);
  const nextDraft = draftAfterExplicitAction(seeded, action);
  const first = explicitForwardMaterialization(action);

  if (!first) {
    return { draft: nextDraft, action };
  }

  // START + presetPurpose は既存effectを待たず、同一updateで目的確定まで進める。
  if (action.type === 'START' && action.pendingPurpose) {
    const afterStart = reducer(data, { type: 'START' });
    const trailing = materializationActionsForDraft(afterStart.state, nextDraft);
    return {
      draft: nextDraft,
      action: { type: 'APPLY_CONVERSATION', actions: [first, ...trailing] },
    };
  }

  const afterFirst = reducer(data, action);
  const trailing = materializationActionsForDraft(afterFirst.state, nextDraft);
  return {
    draft: nextDraft,
    action: {
      type: 'APPLY_CONVERSATION',
      actions: [first, ...trailing],
    },
  };
}

export type NaturalConversationTurnResult = {
  draft: ConversationDraft;
  actions: readonly ConversationMaterializationAction[];
  focus: ConversationFocus;
};

/**
 * 1つの確定発話を multi-slot proposal → 実在directory解決 → draft merge → state event計画へ変換する。
 *
 * state mutation / dispatch / logging はしない。transcript はこの呼び出し中だけ利用し、戻り値にも残さない。
 */
export async function resolveNaturalConversationTurn({
  data,
  draft,
  utterance,
  extractor,
  directory,
  voiceAvailable = true,
  assistanceAvailable = false,
}: {
  data: FlowData;
  draft: ConversationDraft;
  utterance: CommittedReceptionUtterance;
  extractor: ReceptionUtteranceExtractor;
  directory: EntityDirectory;
  voiceAvailable?: boolean;
  assistanceAvailable?: boolean;
}): Promise<NaturalConversationTurnResult> {
  const seeded = seedConversationDraftFromFlowData(draft, data);
  const currentFocus = nextConversationFocus(seeded, {
    voiceAvailable,
    assistanceAvailable,
  });
  const focus = currentFocus.kind === 'collect' || currentFocus.kind === 'disambiguate'
    ? currentFocus.slot
    : undefined;

  const proposal = await extractor.extract({
    transcript: utterance.text,
    ...(focus ? { focus } : {}),
  });
  const resolved = resolveReceptionSlotProposal(proposal, {
    directory,
    sttConfidence: utterance.sttConfidence,
  });
  const merged = mergeConversationDraft(seeded, resolved);
  const actions = materializationActionsForDraft(data.state, merged);
  const nextFocus = nextConversationFocus(merged, {
    voiceAvailable,
    assistanceAvailable,
  });

  return { draft: merged, actions, focus: nextFocus };
}

/** FlowData targetをConversationTargetとして扱えることを明示する型ガード用identity。 */
export function conversationTargetFromFlowTarget(target: Target): ConversationTarget {
  return target;
}

/** 明示操作のテスト fixture 用。 */
export function visitorInfoFromName(name: string): VisitorInfo {
  return { name };
}

/** purpose fixture / adapterで型推論を崩さないためのidentity。 */
export function receptionPurpose(value: ReceptionPurposeId): ReceptionPurposeId {
  return value;
}
