import type {
  ReceptionPurposeId,
  ReceptionTargetType,
  VisitorInfo,
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
  /**
   * 2〜4件程度の候補を想定するが、このdomain型では上限を固定しない。
   * resolver / UI が判断可能な件数へ絞る。
   */
  candidates: readonly T[];
  evidence: {
    source: ConversationSlotSource;
    certainty: 'ambiguous';
  };
};

/** `missing` は slot 自体が無いことで表す。value と missing が同居する不可能状態を作らない。 */
export type ConversationSlot<T> = ResolvedConversationSlot<T> | AmbiguousConversationSlot<T>;

/**
 * directory resolver を通過した、実在する受付先の最小構造。
 * component 層の `ReceptionTarget` へ domain が依存しないため、ここで構造だけ定義する。
 */
export type ConversationTarget = {
  type: ReceptionTargetType;
  id: string;
  label: string;
  /** 同姓同名を画面で区別するための表示専用情報。 */
  sublabel?: string;
};

export type ConversationDraft = {
  purpose?: ConversationSlot<ReceptionPurposeId>;
  target?: ConversationSlot<ConversationTarget>;
  visitorName?: ConversationSlot<string>;
  /** optional。通常journeyでは収集しない。 */
  company?: ConversationSlot<string>;
};

export type RequiredConversationSlot = 'purpose' | 'target' | 'visitorName';

/**
 * 入口により自然な質問順は変わるため順序を注入可能にする。
 * 「担当者を呼ぶ」の既定は target を会話の最初の焦点にする。
 */
export const DEFAULT_CONVERSATION_FOCUS_ORDER: readonly RequiredConversationSlot[] = [
  'target',
  'visitorName',
  'purpose',
];

export type ConversationCapabilities = {
  voiceAvailable: boolean;
  /** 用件を定型ボタンから選べる。既定 true。 */
  purposeTouchAvailable?: boolean;
  /** 担当者/部署を候補・階層ボタンから選べる。既定 true。 */
  targetTouchAvailable?: boolean;
  /** voice-required slot が解決不能なときの有人支援 (#1074)。 */
  assistanceAvailable?: boolean;
  /** entry intent に応じた自然な質問順。 */
  focusOrder?: readonly RequiredConversationSlot[];
};

export type ConversationFocus =
  | {
      kind: 'disambiguate';
      slot: RequiredConversationSlot;
      candidateCount: number;
    }
  | {
      kind: 'collect';
      slot: RequiredConversationSlot;
    }
  | {
      kind: 'assistance';
      slot: RequiredConversationSlot;
    }
  | {
      kind: 'blocked';
      slot: RequiredConversationSlot;
    }
  | { kind: 'finalConfirmation' };

function slotFor(
  draft: ConversationDraft,
  key: RequiredConversationSlot,
): ConversationDraft[RequiredConversationSlot] {
  return draft[key];
}

export function isResolvedConversationSlot<T>(
  slot: ConversationSlot<T> | undefined,
): slot is ResolvedConversationSlot<T> {
  return slot?.kind === 'resolved';
}

/**
 * final confirmation へ進む最低条件。
 * company / note は通常受付成立の条件に含めない。
 */
export function isDraftReadyForFinalConfirmation(draft: ConversationDraft): boolean {
  return (
    isResolvedConversationSlot(draft.purpose) &&
    isResolvedConversationSlot(draft.target) &&
    isResolvedConversationSlot(draft.visitorName)
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
      // 自由な氏名を software keyboard へ落とさない。既知値が無い場合は voice-required。
      return capabilities.voiceAvailable;
  }
}

/**
 * 次に来訪者へ何を聞く/見せるかを決める純関数。
 *
 * 原則:
 * 1. 既に得た情報を聞き直さない。
 * 2. ambiguous な slot は、別の missing slot を増やす前にその場で修復する。
 * 3. missing は entry intent に合った focusOrder で1つだけ聞く。
 * 4. required slot が全て resolved なら final confirmation。
 * 5. voice-required slot を取得できない場合は keyboard ではなく assistance / blocked。
 */
export function nextConversationFocus(
  draft: ConversationDraft,
  capabilities: ConversationCapabilities,
): ConversationFocus {
  const order = capabilities.focusOrder ?? DEFAULT_CONVERSATION_FOCUS_ORDER;

  // まず、既に候補まで分かった曖昧さだけを修復する。
  for (const key of order) {
    const slot = slotFor(draft, key);
    if (slot?.kind !== 'ambiguous') continue;
    if (slot.candidates.length > 0) {
      return { kind: 'disambiguate', slot: key, candidateCount: slot.candidates.length };
    }
    // 空の ambiguous は実質 missing として下段で扱う。
  }

  // 次に本当に足りない情報だけを1つ聞く。
  for (const key of order) {
    const slot = slotFor(draft, key);
    if (slot?.kind === 'resolved') continue;
    if (slot?.kind === 'ambiguous' && slot.candidates.length > 0) continue;

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

/**
 * 1発話から得た複数slotを既存draftへ足す「通常取り込み」。
 *
 * ここでは opportunistic extraction が、すでに来訪者がタッチ/QR等で確定した値を上書きしない。
 * - confirmed は high / ambiguous で上書きしない
 * - ambiguous は resolved で解消できる
 * - high は confirmed なら上書き可能
 * - 同順位の resolved は既存値を維持する
 *
 * 来訪者が明示的に「違う」と訂正した場合は `replaceConversationSlot` を使う。
 */
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
  return {
    ...(mergeSlot(current.purpose, incoming.purpose) === undefined
      ? {}
      : { purpose: mergeSlot(current.purpose, incoming.purpose) }),
    ...(mergeSlot(current.target, incoming.target) === undefined
      ? {}
      : { target: mergeSlot(current.target, incoming.target) }),
    ...(mergeSlot(current.visitorName, incoming.visitorName) === undefined
      ? {}
      : { visitorName: mergeSlot(current.visitorName, incoming.visitorName) }),
    ...(mergeSlot(current.company, incoming.company) === undefined
      ? {}
      : { company: mergeSlot(current.company, incoming.company) }),
  } as ConversationDraft;
}

/**
 * 明示訂正用。指定slot以外はそのまま保持する（Repair, don't restart）。
 */
export function replaceConversationSlot<K extends keyof ConversationDraft>(
  draft: ConversationDraft,
  key: K,
  value: ConversationDraft[K],
): ConversationDraft {
  if (value === undefined) {
    const next = { ...draft };
    delete next[key];
    return next;
  }
  return { ...draft, [key]: value };
}

/**
 * Draft を既存 state machine に安全に materialize するための「計画」だけを返す。
 * 実行は caller の reducer/dispatch が担う。
 *
 * `CONFIRM` は絶対に返さない。呼び出し確定は `confirming` 画面の明示タッチだけが行う。
 */
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
    if (!isResolvedConversationSlot(draft.purpose)) return actions;
    if (!append({ type: 'SELECT_PURPOSE', purpose: draft.purpose.value })) return actions;
  }

  if (state === 'selectingTarget') {
    if (!isResolvedConversationSlot(draft.target)) return actions;
    if (!append({ type: 'SELECT_TARGET', target: draft.target.value })) return actions;
  }

  if (state === 'inputVisitorInfo') {
    if (!isResolvedConversationSlot(draft.visitorName)) return actions;
    const company = isResolvedConversationSlot(draft.company)
      ? draft.company.value.trim() || undefined
      : undefined;
    if (
      !append({
        type: 'SUBMIT_VISITOR_INFO',
        visitor: {
          name: draft.visitorName.value.trim(),
          ...(company ? { company } : {}),
        },
      })
    ) {
      return actions;
    }
  }

  // confirming に着いても CONFIRM は返さない。
  return actions;
}
