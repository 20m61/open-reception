import {
  isReceptionPurposeId,
  isVisitorNameWithinLimit,
  type ReceptionPurposeId,
  type ReceptionTargetType,
} from './session';
import { transition, type ReceptionEvent, type ReceptionState } from './state';

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
 * - 氏名を尋ねるのは `inputVisitorInfo` に居るときだけ（§2）。
 * - 後から来た明示の値が勝つ。音声の値は、画面で明示した値を上書きしない（§3-c）。
 * - 「戻る」で戻った画面とその先の slot は捨てる。戻った直後に前へ押し戻さない（§3-c・§3-d）。
 *
 * 画面を通り過ぎた slot（不変条件。#1088 の 3 周目）:
 * - 状態 S に居るなら、S より手前の画面で埋める slot は状態機械が既に受け取っている
 *   （`SELECT_PURPOSE` / `SELECT_TARGET` / `SUBMIT_VISITOR_INFO` を経ないと S へ来られない）。
 *   この事実は state だけから分かるので、planner は draft にその値が写っているかを見ない。
 * - S では、手前の画面の slot を尋ねない（`disambiguate` / `collect` / `readback` にしない）。
 * - S での merge は、手前の画面の slot を変えない（足しも消しもしない）。そこを開け直すのは、
 *   戻った画面とその先を捨てる `BACK` だけ。
 * - 手前の画面の slot の正本は session（呼び出す相手・送信した氏名）。draft に残る値は画面で
 *   確定した値の写しとは限らないので、最終確認で読み上げる内容は session から読む。
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

const REQUIRED_SLOTS: readonly RequiredConversationSlot[] = ['purpose', 'target', 'visitorName'];

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
  /**
   * entry intent に応じた自然な質問順。尋ねる順を決めるだけで、最終確認へ進むかどうかには
   * 影響しない。重複は無視し、含まれない必須 slot は既定の順で後ろへ足す。
   */
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
      /**
       * 候補から選んでもらう。候補が 1 件（`candidateCount: 1`）でも、自動では確定しない。
       * その 1 件を見せて「この方でよろしいですか」と確かめる（復唱と同じ扱い）。曖昧と判定された
       * 相手を planner が確定へ格上げすると、同じ姓の担当者がいるときの復唱（ADR 0011 §3-f）を
       * 迂回するため。
       */
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
  | { kind: 'finalConfirmation' }
  | {
      /**
       * この画面で声で尋ねることは無い。画面の操作（と materialization plan）を待つ。
       * 受付途中の 4 状態以外に居るとき、または残る不足が氏名だけで `inputVisitorInfo` に
       * 居ないとき（氏名はその画面に着いてから尋ねる。ADR 0011 §2）。
       */
      kind: 'awaitScreen';
    };

export function isResolvedConversationSlot<T>(
  slot: ConversationSlot<T> | undefined,
): slot is ResolvedConversationSlot<T> {
  return slot?.kind === 'resolved';
}

/**
 * 見える文字を 1 つ以上含むか。空白と、表示されない文字（U+200B ゼロ幅スペースなどの
 * Default_Ignorable_Code_Point）だけの値は、画面にも読み上げにも何も出ないので無効とする。
 */
function hasVisibleText(text: string): boolean {
  return text.replace(/[\s\p{Default_Ignorable_Code_Point}]/gu, '') !== '';
}

function validTarget(target: ConversationTarget): boolean {
  return hasVisibleText(target.id) && hasVisibleText(target.label);
}

function validVisitorName(name: string): boolean {
  return hasVisibleText(name) && isVisitorNameWithinLimit(name);
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

/** draft を保持してよい、受付途中の状態（画面の並び順）。 */
const RETAINED_STATE_ORDER: readonly ReceptionState[] = [
  'selectingPurpose',
  'selectingTarget',
  'inputVisitorInfo',
  'confirming',
];
const DRAFT_RETAINED_STATES: ReadonlySet<ReceptionState> = new Set(RETAINED_STATE_ORDER);

const DRAFT_KEYS = ['purpose', 'target', 'visitorName', 'company'] as const satisfies readonly (keyof ConversationDraft)[];

/** 各 slot を来訪者が画面で埋める状態。受付途中の状態の並び（`RETAINED_STATE_ORDER`）の上の位置で比べる。 */
const SLOT_SCREEN: Record<keyof ConversationDraft, ReceptionState> = {
  purpose: 'selectingPurpose',
  target: 'selectingTarget',
  visitorName: 'inputVisitorInfo',
  company: 'inputVisitorInfo',
};

/**
 * 状態 `state` に居るとき、`key` を埋める画面をもう通り過ぎたか（状態機械が値を受け取り済みか）。
 * 受付途中の 4 状態以外では、どの slot も通り過ぎていない扱いにする（idle で聞き取った値は
 * `START` 後の draft へ持ち越すため）。`BACK` で捨てる範囲もこの述語の否定で決まる。
 */
function isPastScreen(key: keyof ConversationDraft, state: ReceptionState): boolean {
  const here = RETAINED_STATE_ORDER.indexOf(state);
  return here >= 0 && RETAINED_STATE_ORDER.indexOf(SLOT_SCREEN[key]) < here;
}

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
    company: keepValid(notFromVoice(draft.company), hasVisibleText),
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
 * draft だけで見た、final confirmation へ進む最低条件。
 * company / note は通常受付成立の条件に含めない。
 *
 * state を知らないので、画面で確定した値（`SELECT_TARGET` の相手・`SUBMIT_VISITOR_INFO` の氏名）を
 * draft へ写さない呼び出し側では偽になる。画面の進み具合を含めた判定は
 * `nextConversationFocus(draft, state)` が `finalConfirmation` を返すかで見る。
 */
export function isDraftReadyForFinalConfirmation(draft: ConversationDraft): boolean {
  const normalized = normalizeConversationDraft(draft);
  return REQUIRED_SLOTS.every((key) => isAcquired(normalized, key));
}

/** 重複を除き、含まれない必須 slot を既定の順で後ろへ足す（どの slot も取りこぼさない）。 */
function completeFocusOrder(order: readonly RequiredConversationSlot[]): readonly RequiredConversationSlot[] {
  return [...new Set([...order, ...DEFAULT_CONVERSATION_FOCUS_ORDER])];
}

/**
 * 次に来訪者へ何を聞く/見せるかを決める純関数。
 *
 * 原則:
 * 1. 既に得た情報を聞き直さない。
 * 2. ambiguous な slot は、別の missing slot を増やす前にその場で修復する。
 * 3. missing は entry intent に合った focusOrder で1つだけ聞く。
 * 4. 高信頼の氏名は復唱する（自動では確定しない）。
 * 5. required slot が全て取得済みなら final confirmation（focusOrder に依らない）。
 * 6. 「入力できない」は返さない。音声・有人支援が無くてもキーボード／タッチで `collect` する。
 * 7. 氏名は `inputVisitorInfo` に居るときだけ尋ねる（ADR 0011 §2。通知より前に尋ねない）。
 * 8. 通り過ぎた画面の slot は尋ねず、取得済みとみなす（`isPastScreen`）。`confirming` では
 *    draft の中身に依らず `finalConfirmation`。手前の画面の値を draft へ写すかどうかに依らない。
 */
export function nextConversationFocus(
  draft: ConversationDraft,
  state: ReceptionState,
  options: ConversationFocusOptions = {},
): ConversationFocus {
  if (!DRAFT_RETAINED_STATES.has(state)) return { kind: 'awaitScreen' };
  const normalized = normalizeConversationDraft(draft);
  const open = REQUIRED_SLOTS.filter((key) => !isPastScreen(key, state));
  if (open.every((key) => isAcquired(normalized, key))) return { kind: 'finalConfirmation' };

  const order = completeFocusOrder(options.focusOrder ?? DEFAULT_CONVERSATION_FOCUS_ORDER).filter(
    (key) => open.includes(key) && (key !== 'visitorName' || state === 'inputVisitorInfo'),
  );

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

  return { kind: 'awaitScreen' };
}

/**
 * 確定の強さ。画面での明示（タッチ・キーボード・QR・予約）で確定 2 > 音声の復唱で確定 1 > 未確定 0
 * （高信頼・曖昧）。音声で確定した値を画面の明示より下に置くのは、キーボードで直した値を音声が
 * 上書きしないため（ADR 0011 §3-c）。
 */
function confirmationRank(slot: ConversationSlot<unknown>): number {
  if (slot.kind === 'ambiguous' || slot.evidence.certainty !== 'confirmed') return 0;
  return slot.evidence.source === 'voice' ? 1 : 2;
}

/**
 * 1発話から得た複数slotや、画面での入力を既存draftへ足す。
 *
 * 両側を正規化してから比べるので、無効な値は順位を持たない（後から来た有効な値を阻まない）。
 * 不変条件（どちらも同じ比較の両側）:
 * - 未確定（高信頼・曖昧）の値は、後から来たどの値にも置き換わる。言い直しが曖昧と判定されても
 *   （同じ姓の担当者がいて復唱が要るとき。ADR 0011 §3-f）、前の聞き取りを残さない。
 * - 確定した値は、同じ強さ以上の確定にだけ置き換わる（同じなら新しいほう）。タッチで選び直した
 *   相手やキーボードで直した氏名は残り、発話のついでに拾った値や音声の値は、来訪者が画面で
 *   確定した値を上書きしない。
 *
 * incoming に slot が無いことは「その slot について何も言っていない」と読む。正規化で落ちる値
 * （曖昧な氏名・上限を超えた氏名・見える文字の無い値・音声の目的や会社名）も同じく「言及なし」に
 * なり、前の値が残る。言い直しを聞き取ったが使える値にならなかった（不在の人を名指しした・
 * 確信度が下限未満・氏名が曖昧／長すぎ／空）ときに前の値を消すのは、呼び出し側が
 * `replaceConversationSlot(draft, key, undefined)` で行う。行わないと、前の氏名がまた復唱される。
 */
function mergeSlot<T>(
  current: ConversationSlot<T> | undefined,
  incoming: ConversationSlot<T> | undefined,
): ConversationSlot<T> | undefined {
  if (incoming === undefined) return current;
  if (current === undefined) return incoming;
  return confirmationRank(incoming) >= confirmationRank(current) ? incoming : current;
}

/**
 * `state` は今居る受付の状態。通り過ぎた画面の slot（`isPastScreen`）は、incoming に何があっても
 * current の正規化のまま返す（足しも消しもしない）。例: `inputVisitorInfo` で氏名を言うついでに
 * 「鈴木さんに会いに来た」と言い、相手が曖昧（佐藤・鈴木）と出ても、状態機械が受け取った相手を
 * draft の上で差し替えない（#1088 の 3 周目 MAJOR-A）。そこを直すのは `BACK` で戻ってから。
 */
export function mergeConversationDraft(
  current: ConversationDraft,
  incoming: Partial<ConversationDraft>,
  state: ReceptionState,
): ConversationDraft {
  const a = normalizeConversationDraft(current);
  const b = normalizeConversationDraft(incoming);
  const past = (key: keyof ConversationDraft) => isPastScreen(key, state);
  return withoutUndefined({
    purpose: past('purpose') ? a.purpose : mergeSlot(a.purpose, b.purpose),
    target: past('target') ? a.target : mergeSlot(a.target, b.target),
    visitorName: past('visitorName') ? a.visitorName : mergeSlot(a.visitorName, b.visitorName),
    company: past('company') ? a.company : mergeSlot(a.company, b.company),
  });
}

/**
 * 明示訂正用。指定slot以外はそのまま保持する（Repair, don't restart）。順位を比べずに置き換える。
 * 無効な値での訂正や `undefined` は slot を消す（再び尋ねる対象へ戻す）。
 * 復唱に「いいえ」と答えたとき、言い直しを聞き取ったが使える値にならなかったとき（不在の人の名指し・
 * 確信度が下限未満・曖昧／長すぎ／見える文字の無い氏名）は、merge ではなくこれで消す（merge は
 * slot の無い incoming も、正規化で落ちる incoming も「言及なし」と読み、前の値を残す）。
 * state を見ないので、通り過ぎた画面の slot も消せる。画面の状態と食い違わないよう、そこは
 * `BACK` で戻ってから直す。
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

/**
 * 受付の状態を変えるイベントごとに通す。
 *
 * - 受付途中の 4 状態以外（RESET・無操作リセット後の idle、キャンセル、発信以降、完了）では
 *   空の draft を返す。前の来訪者の氏名を、次の来訪者の画面に出さないため（ADR 0011 §6）。
 * - `BACK` では、戻った先の画面とそれより先の画面の slot を捨てる。来訪者は選び直す・直すために
 *   戻ったので、draft に残った値で前へ押し戻したり（`SELECT_TARGET`）、キーボードで直した氏名を
 *   prefill で上書きしたりしない。戻った画面の入力欄に残る値は、画面側の状態が正本になる。
 *   確認画面から戻った `inputVisitorInfo` では、焦点は氏名の `collect` になるが、ADR 0011 §3-c の
 *   とおり呼び出し側は音声での聞き取りを自動で始めない（直すのはキーボード）。
 * - 遷移表に無いイベントは状態を変えないので、今の状態のまま正規化して返す。
 */
export function conversationDraftAfterTransition(
  draft: ConversationDraft,
  from: ReceptionState,
  event: ReceptionEvent,
): ConversationDraft {
  const to = transition(from, event);
  const state = to ?? from;
  if (!DRAFT_RETAINED_STATES.has(state)) return {};
  const normalized = normalizeConversationDraft(draft);
  if (to === null || event !== 'BACK') return normalized;

  const kept: ConversationDraft = {};
  for (const key of DRAFT_KEYS) {
    if (isPastScreen(key, to)) (kept as Record<string, unknown>)[key] = normalized[key];
  }
  return withoutUndefined(kept);
}
