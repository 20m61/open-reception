import {
  isReceptionPurposeId,
  type ReceptionPurposeId,
  type ReceptionTargetType,
  type VisitorInfo,
} from './session';
import {
  transition,
  type ReceptionEvent,
  type ReceptionState,
} from './state';

/**
 * Minimum-Turn Natural Conversation (#1077 / #1079).
 *
 * `ReceptionState` は安全な内部状態として維持する一方、来訪者が一度の発話で state 順より
 * 先の情報まで話した場合に、それを捨てず短命に保持するための純ドメインモデル。
 *
 * PII を含み得る `visitorName` / `company` はメモリ内の会話 draft にだけ置く想定で、
 * audit / experience metrics へ値を渡してはならない。
 */

export type ConversationSlotSource = 'touch' | 'voice' | 'qr' | 'reservation';
export type ResolvedSlotCertainty = 'confirmed' | 'high';

export type SlotEvidence = {
  source: ConversationSlotSource;
  certainty: ResolvedSlotCertainty | 'ambiguous';
};

export type ResolvedConversationSlot<T> = {
  kind: 'resolved';
  value: T;
  evidence: {
    source: ConversationSlotSource;
    certainty: ResolvedSlotCertainty;
  };
};

export type AmbiguousConversationSlot<T> = {
  kind: 'ambiguous';
  candidates: readonly T[];
  evidence: {
    source: ConversationSlotSource;
    certainty: 'ambiguous';
  };
};

export type ConversationSlot<T> = ResolvedConversationSlot<T> | AmbiguousConversationSlot<T>;

export type ConversationTarget = {
  type: ReceptionTargetType;
  id: string;
  label: string;
  sublabel?: string;
};

export type ConversationDraft = {
  purpose?: ConversationSlot<ReceptionPurposeId>;
  target?: ConversationSlot<ConversationTarget>;
  visitorName?: ConversationSlot<string>;
  company?: ConversationSlot<string>;
};

export type RequiredConversationSlot = 'purpose' | 'target' | 'visitorName';

export const DEFAULT_CONVERSATION_FOCUS_ORDER: readonly RequiredConversationSlot[] = [
  'target',
  'visitorName',
  'purpose',
];

export type ConversationCapabilities = {
  voiceAvailable: boolean;
  purposeTouchAvailable?: boolean;
  targetTouchAvailable?: boolean;
  assistanceAvailable?: boolean;
  focusOrder?: readonly RequiredConversationSlot[];
};

export type ConversationFocus =
  | { kind: 'disambiguate'; slot: RequiredConversationSlot; candidateCount: number }
  | { kind: 'collect'; slot: RequiredConversationSlot }
  | { kind: 'assistance'; slot: RequiredConversationSlot }
  | { kind: 'blocked'; slot: RequiredConversationSlot }
  | { kind: 'finalConfirmation' };

export function isResolvedConversationSlot<T>(
  slot: ConversationSlot<T> | undefined,
): slot is ResolvedConversationSlot<T> {
  return slot?.kind === 'resolved';
}

function validTarget(target: ConversationTarget): boolean {
  return target.id.trim() !== '' && target.label.trim() !== '';
}

function hasMeaningfulResolvedSlot(
  draft: ConversationDraft,
  key: RequiredConversationSlot,
): boolean {
  switch (key) {
    case 'purpose':
      return isResolvedConversationSlot(draft.purpose) && isReceptionPurposeId(draft.purpose.value);
    case 'target':
      return isResolvedConversationSlot(draft.target) && validTarget(draft.target.value);
    case 'visitorName':
      return isResolvedConversationSlot(draft.visitorName) && draft.visitorName.value.trim() !== '';
  }
}

function meaningfulCandidateCount(
  draft: ConversationDraft,
  key: RequiredConversationSlot,
): number {
  switch (key) {
    case 'purpose':
      return draft.purpose?.kind === 'ambiguous'
        ? draft.purpose.candidates.filter(isReceptionPurposeId).length
        : 0;
    case 'target':
      return draft.target?.kind === 'ambiguous'
        ? draft.target.candidates.filter(validTarget).length
        : 0;
    case 'visitorName':
      return draft.visitorName?.kind === 'ambiguous'
        ? draft.visitorName.candidates.filter((name) => name.trim() !== '').length
        : 0;
  }
}

export function isDraftReadyForFinalConfirmation(draft: ConversationDraft): boolean {
  return (
    hasMeaningfulResolvedSlot(draft, 'purpose') &&
    hasMeaningfulResolvedSlot(draft, 'target') &&
    hasMeaningfulResolvedSlot(draft, 'visitorName')
  );
}

function canCollect(
  slot: RequiredConversationSlot,
  capabilities: ConversationCapabilities,
): boolean {
  switch (slot) {
    case 'purpose':
      return (capabilities.purposeTouchAvailable ?? true) || capabilities.voiceAvailable;
    case 'target':
      return (capabilities.targetTouchAvailable ?? true) || capabilities.voiceAvailable;
    case 'visitorName':
      return capabilities.voiceAvailable;
  }
}

export function nextConversationFocus(
  draft: ConversationDraft,
  capabilities: ConversationCapabilities,
): ConversationFocus {
  const order = capabilities.focusOrder ?? DEFAULT_CONVERSATION_FOCUS_ORDER;

  for (const key of order) {
    const candidateCount = meaningfulCandidateCount(draft, key);
    if (candidateCount > 0) {
      return { kind: 'disambiguate', slot: key, candidateCount };
    }
  }

  for (const key of order) {
    if (hasMeaningfulResolvedSlot(draft, key)) continue;

    if (canCollect(key, capabilities)) {
      return { kind: 'collect', slot: key };
    }
    return capabilities.assistanceAvailable
      ? { kind: 'assistance', slot: key }
      : { kind: 'blocked', slot: key };
  }

  return { kind: 'finalConfirmation' };
}

function evidenceRank(slot: ConversationSlot<unknown>): number {
  if (slot.kind === 'ambiguous') return 0;
  return slot.evidence.certainty === 'confirmed' ? 2 : 1;
}

function mergeSlot<T>(
  current: ConversationSlot<T> | undefined,
  incoming: ConversationSlot<T> | undefined,
): ConversationSlot<T> | undefined {
  if (incoming === undefined) return current;
  if (current === undefined) return incoming;
  return evidenceRank(incoming) > evidenceRank(current) ? incoming : current;
}

export function mergeConversationDraft(
  current: ConversationDraft,
  incoming: Partial<ConversationDraft>,
): ConversationDraft {
  const purpose = mergeSlot(current.purpose, incoming.purpose);
  const target = mergeSlot(current.target, incoming.target);
  const visitorName = mergeSlot(current.visitorName, incoming.visitorName);
  const company = mergeSlot(current.company, incoming.company);

  return {
    ...(purpose === undefined ? {} : { purpose }),
    ...(target === undefined ? {} : { target }),
    ...(visitorName === undefined ? {} : { visitorName }),
    ...(company === undefined ? {} : { company }),
  };
}

export function replaceConversationSlot<K extends keyof ConversationDraft>(
  draft: ConversationDraft,
  key: K,
  value: ConversationDraft[K],
): ConversationDraft {
  if (value === undefined) {
    const next: ConversationDraft = { ...draft };
    delete next[key];
    return next;
  }
  return { ...draft, [key]: value };
}

export type ConversationMaterializationAction =
  | { type: 'START' }
  | { type: 'SELECT_PURPOSE'; purpose: ReceptionPurposeId }
  | { type: 'SELECT_TARGET'; target: ConversationTarget }
  | { type: 'SUBMIT_VISITOR_INFO'; visitor: VisitorInfo };

function eventFor(action: ConversationMaterializationAction): ReceptionEvent {
  return action.type;
}

export function materializationActionsForDraft(
  initialState: ReceptionState,
  draft: ConversationDraft,
): readonly ConversationMaterializationAction[] {
  const actions: ConversationMaterializationAction[] = [];
  let state = initialState;

  const append = (action: ConversationMaterializationAction): boolean => {
    const next = transition(state, eventFor(action));
    if (next === null) return false;
    actions.push(action);
    state = next;
    return true;
  };

  if (state === 'idle') {
    if (!append({ type: 'START' })) return actions;
  }

  if (state === 'selectingPurpose') {
    if (!hasMeaningfulResolvedSlot(draft, 'purpose')) return actions;
    const purpose = draft.purpose;
    if (!isResolvedConversationSlot(purpose)) return actions;
    if (!append({ type: 'SELECT_PURPOSE', purpose: purpose.value })) return actions;
  }

  if (state === 'selectingTarget') {
    if (!hasMeaningfulResolvedSlot(draft, 'target')) return actions;
    const target = draft.target;
    if (!isResolvedConversationSlot(target)) return actions;
    if (!append({ type: 'SELECT_TARGET', target: target.value })) return actions;
  }

  if (state === 'inputVisitorInfo') {
    if (!hasMeaningfulResolvedSlot(draft, 'visitorName')) return actions;
    const visitorName = draft.visitorName;
    if (!isResolvedConversationSlot(visitorName)) return actions;

    const company = isResolvedConversationSlot(draft.company)
      ? draft.company.value.trim() || undefined
      : undefined;
    if (
      !append({
        type: 'SUBMIT_VISITOR_INFO',
        visitor: {
          name: visitorName.value.trim(),
          ...(company ? { company } : {}),
        },
      })
    ) {
      return actions;
    }
  }

  return actions;
}
