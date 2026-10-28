import {
  isReceptionPurposeId,
  isVisitorNameWithinLimit,
  type ReceptionPurposeId,
  type ReceptionTargetType,
} from './session';
import { transition, type ReceptionState } from './state';

/**
 * Minimum-Turn Natural Conversation (#1077 / #1079).
 *
 * `ReceptionState` は安全な内部状態として維持する一方、来訪者が一度の発話で state 順より
 * 先の情報まで話した場合に、それを捨てず短命に保持するための純ドメインモデル。
 *
 * PII を含み得る `visitorName` / `company` はメモリ内の会話 draft にだけ置く想定で、
 * audit / experience metrics / アプリログへ値を渡してはならない（ADR 0011 §6）。
 * このモジュールは I/O を持たず、`ConversationFocus` にも値を載せない。
 *
 * ADR 0011 に従う境界:
 * - 氏名は確信度に関係なく、復唱への肯定（`confirmed`）を経るまで取得済みとみなさない（§3-b）。
 * - 氏名は `inputVisitorInfo` の画面を飛ばして確定しない。planner は `SUBMIT_VISITOR_INFO` を
 *   作らず、復唱で確定済みの氏名を prefill として返すだけ（§2）。
 * - キーボードは常に使える。planner は「入力できない」を返さない（§4）。
 * - 目的と会社名は音声から埋めない（§1・§5）。音声由来の値は draft に入れた時点で落とす。
 * - 受付途中の 4 状態以外では draft を必ず捨てる（§6）。
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

export type ConversationFocusOptions = {
  /** entry intent に応じた自然な質問順。 */
  focusOrder?: readonly RequiredConversationSlot[];
};

/**
 * 次に来訪者へ何を尋ねるか。値（氏名・会社名など）は載せない。
 *
 * 「入力できない」を表す種類は持たない。`collect` の入力手段は呼び出し側が決めるが、
 * 目的・相手はタッチ、氏名はキーボードが常に使える（ADR 0011 §4）。音声は上乗せの手段。
 */
export type ConversationFocus =
  | {
      kind: 'disambiguate';
      slot: RequiredConversationSlot;
      /** 来訪者に見せる候補の数。正規化済み draft の `candidates.length` と一致する。 */
      candidateCount: number;
    }
  | {
      kind: 'collect';
      slot: RequiredConversationSlot;
    }
  | {
      /** 高信頼に聞き取った氏名を、画面と読み上げで復唱して確かめる（ADR 0011 §3-b）。 */
      kind: 'readback';
      slot: 'visitorName';
    }
  | { kind: 'finalConfirmation' };

export function isResolvedConversationSlot<T>(
  slot: ConversationSlot<T> | undefined,
): slot is ResolvedConversationSlot<T> {
  return slot?.kind === 'resolved';
}

function validTarget(target: ConversationTarget): boolean {
  return target.id.trim() !== '' && target.label.trim() !== '';
}

function validVisitorName(name: string): boolean {
  return name.trim() !== '' && isVisitorNameWithinLimit(name);
}

function validText(text: string): boolean {
  return text.trim() !== '';
}

/**
 * slot を「意味的に有効な値だけ」へ落とす。無効な値を draft に残すと、後から来た
 * 有効な値を merge の順位で阻み、同じ質問を繰り返す原因になる（#1088 MAJOR-3）。
 * - resolved で無効 → slot 無し
 * - ambiguous → 有効な候補だけを残し、0 件なら slot 無し
 */
function keepValid<T>(
  slot: ConversationSlot<T> | undefined,
  isValid: (value: T) => boolean,
): ConversationSlot<T> | undefined {
  if (slot === undefined) return undefined;
  if (slot.kind === 'resolved') return isValid(slot.value) ? slot : undefined;
  const candidates = slot.candidates.filter(isValid);
  if (candidates.length === 0) return undefined;
  return candidates.length === slot.candidates.length ? slot : { ...slot, candidates };
}

function notFromVoice<T>(slot: ConversationSlot<T> | undefined): ConversationSlot<T> | undefined {
  return slot?.evidence.source === 'voice' ? undefined : slot;
}

/** 氏名は復唱に 1 つの候補だけを出す（ADR 0011 §6）。曖昧な氏名は候補選択にせず、聞き直す。 */
function notAmbiguous<T>(slot: ConversationSlot<T> | undefined): ConversationSlot<T> | undefined {
  return slot?.kind === 'ambiguous' ? undefined : slot;
}

const DRAFT_KEYS = ['purpose', 'target', 'visitorName', 'company'] as const satisfies readonly (keyof ConversationDraft)[];

function withoutUndefined(draft: ConversationDraft): ConversationDraft {
  const next: ConversationDraft = {};
  for (const key of DRAFT_KEYS) {
    const slot = draft[key];
    if (slot !== undefined) (next as Record<string, unknown>)[key] = slot;
  }
  return next;
}

/**
 * draft を正規化する。無効な値・音声から埋めない slot を落とし、曖昧な候補を有効なものに絞る。
 * merge / focus / materialize はすべてこれを通した draft を見る。
 */
export function normalizeConversationDraft(draft: ConversationDraft): ConversationDraft {
  return withoutUndefined({
    // 目的は音声から扱わない（ADR 0011 §1、owner の決定）。
    purpose: keepValid(notFromVoice(draft.purpose), isReceptionPurposeId),
    target: keepValid(draft.target, validTarget),
    visitorName: keepValid(notAmbiguous(draft.visitorName), validVisitorName),
    // 会社名などの任意の欄は音声から埋めない（ADR 0011 §5）。
    company: keepValid(notFromVoice(draft.company), validText),
  });
}

/** 正規化済みの draft について、その slot を再び尋ねなくてよいか。 */
function isAcquired(draft: ConversationDraft, key: RequiredConversationSlot): boolean {
  switch (key) {
    case 'purpose':
      return isResolvedConversationSlot(draft.purpose);
    case 'target':
      return isResolvedConversationSlot(draft.target);
    case 'visitorName':
      // 氏名は復唱への肯定（またはタッチ等の明示入力）を経た confirmed だけ（ADR 0011 §3-b）。
      return (
        isResolvedConversationSlot(draft.visitorName) &&
        draft.visitorName.evidence.certainty === 'confirmed'
      );
  }
}

/**
 * final confirmation へ進む最低条件。
 * company / note は通常受付成立の条件に含めない。
 */
export function isDraftReadyForFinalConfirmation(draft: ConversationDraft): boolean {
  const normalized = normalizeConversationDraft(draft);
  return (
    isAcquired(normalized, 'purpose') &&
    isAcquired(normalized, 'target') &&
    isAcquired(normalized, 'visitorName')
  );
}

/**
 * 次に来訪者へ何を聞く/見せるかを決める純関数。
 *
 * 原則:
 * 1. 既に得た情報を聞き直さない。
 * 2. ambiguous な slot は、別の missing slot を増やす前にその場で修復する。
 * 3. missing は entry intent に合った focusOrder で1つだけ聞く。
 * 4. 高信頼の氏名は復唱する（自動では確定しない）。
 * 5. required slot が全て取得済みなら final confirmation。
 * 6. 「入力できない」は返さない。音声・有人支援が無くてもキーボード／タッチで `collect` する。
 */
export function nextConversationFocus(
  draft: ConversationDraft,
  options: ConversationFocusOptions = {},
): ConversationFocus {
  const order = options.focusOrder ?? DEFAULT_CONVERSATION_FOCUS_ORDER;
  const normalized = normalizeConversationDraft(draft);

  // まず、既に候補まで分かった曖昧さだけを修復する。
  for (const key of order) {
    const slot = normalized[key];
    if (slot?.kind === 'ambiguous') {
      return { kind: 'disambiguate', slot: key, candidateCount: slot.candidates.length };
    }
  }

  // 次に本当に足りない情報だけを1つ聞く。
  for (const key of order) {
    if (isAcquired(normalized, key)) continue;
    if (key === 'visitorName' && isResolvedConversationSlot(normalized.visitorName)) {
      return { kind: 'readback', slot: 'visitorName' };
    }
    return { kind: 'collect', slot: key };
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
 * 両側を正規化してから比べるので、無効な値は順位を持たない（後から来た有効な値を阻まない）。
 * opportunistic extraction が、すでに来訪者がタッチ/QR等で確定した値を上書きしない:
 * - confirmed は high / ambiguous で上書きしない
 * - ambiguous は resolved で解消できる
 * - high は confirmed なら上書き可能
 * - 同順位は既存値を維持する
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
  const a = normalizeConversationDraft(current);
  const b = normalizeConversationDraft(incoming);
  return withoutUndefined({
    purpose: mergeSlot(a.purpose, b.purpose),
    target: mergeSlot(a.target, b.target),
    visitorName: mergeSlot(a.visitorName, b.visitorName),
    company: mergeSlot(a.company, b.company),
  });
}

/**
 * 明示訂正用。指定slot以外はそのまま保持する（Repair, don't restart）。
 * 無効な値での訂正は slot を消す（再び尋ねる対象へ戻す）。
 */
export function replaceConversationSlot<K extends keyof ConversationDraft>(
  draft: ConversationDraft,
  key: K,
  value: ConversationDraft[K],
): ConversationDraft {
  return normalizeConversationDraft({ ...draft, [key]: value });
}

/**
 * Draft を既存 state machine に安全に materialize するための「計画」だけを返す。
 * 実行は caller の reducer/dispatch が担う。
 *
 * 返す action は `SELECT_TARGET` だけ（ADR 0007 / ADR 0011 §1 で音声から起こせる遷移のうち、
 * 画面を飛ばさないもの）。
 * - `START` / `SELECT_PURPOSE` は作らない（目的は画面で選ぶ。カスタムフローの選択もそこで行う）。
 * - `SUBMIT_VISITOR_INFO` は作らない。`inputVisitorInfo` の画面（プライバシー通知と
 *   キーボード欄がある）を必ず通す。復唱で確定済みの氏名は `visitorNamePrefill` で返す（§2）。
 * - `CONFIRM` は絶対に作らない。呼び出し確定は `confirming` 画面の明示タッチだけが行う。
 */
export type ConversationMaterializationAction = { type: 'SELECT_TARGET'; target: ConversationTarget };

export type ConversationMaterializationPlan = {
  actions: readonly ConversationMaterializationAction[];
  /** actions を順に適用した後の state。 */
  endState: ReceptionState;
  /**
   * `endState` が `inputVisitorInfo` で、氏名が復唱で確定済みのときだけ入る、入力欄の初期値。
   * 送信（`SUBMIT_VISITOR_INFO`）は画面側の明示の操作か、ADR 0011 §5 の条件で行う。
   */
  visitorNamePrefill?: string;
};

export function materializationPlanForDraft(
  initialState: ReceptionState,
  draft: ConversationDraft,
): ConversationMaterializationPlan {
  const normalized = normalizeConversationDraft(draft);
  const actions: ConversationMaterializationAction[] = [];
  let state = initialState;

  if (state === 'selectingTarget' && isResolvedConversationSlot(normalized.target)) {
    const next = transition(state, 'SELECT_TARGET');
    if (next !== null) {
      actions.push({ type: 'SELECT_TARGET', target: normalized.target.value });
      state = next;
    }
  }

  const name = normalized.visitorName;
  if (state === 'inputVisitorInfo' && isAcquired(normalized, 'visitorName') && name?.kind === 'resolved') {
    return { actions, endState: state, visitorNamePrefill: name.value.trim() };
  }
  return { actions, endState: state };
}

/** draft を保持してよい、受付途中の状態。 */
const DRAFT_RETAINED_STATES: ReadonlySet<ReceptionState> = new Set<ReceptionState>([
  'selectingPurpose',
  'selectingTarget',
  'inputVisitorInfo',
  'confirming',
]);

/**
 * 受付の状態が変わるたびに通す。受付途中の 4 状態以外（RESET・無操作リセット後の idle、
 * キャンセル、発信以降、完了）では空の draft を返す。前の来訪者の氏名を、次の来訪者の
 * 画面に出さないため（ADR 0011 §6）。
 */
export function conversationDraftForState(
  draft: ConversationDraft,
  state: ReceptionState,
): ConversationDraft {
  return DRAFT_RETAINED_STATES.has(state) ? normalizeConversationDraft(draft) : {};
}
