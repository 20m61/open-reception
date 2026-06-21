/**
 * 受付UXの状態駆動契約 (issue #120 / Epic #119)。
 *
 * 目的: タッチUI・チャットUI・アバターが「同じ受付状態」を参照し、表示・発話・操作が
 * ズレないようにするための純型 + 純関数の契約。役割分担は Avatar-led / Touch-first /
 * Chat-assisted（詳細は docs/reception-ux-contract.md）。
 *
 * 設計原則:
 *  - 本モジュールは副作用なし（純関数のみ）。状態の所有者はあくまで state.ts の
 *    `ReceptionState` / `transition`。本契約はそこから「導出」するだけで、独自に状態を
 *    進めたり矛盾する状態を作らない。
 *  - チャット/LLM が実行できる操作は `availableActions(state)` の集合に限定する。
 *    自由文 → 任意の操作、を禁じ、必ず許可済みアクションへ変換させる。
 *  - 呼び出し確定・個人情報確定などの重要操作は、自由文だけで確定させない。必ず
 *    `confirming` 画面を経由する不変条件を型/関数で表現する（REQUIRES_CONFIRMATION）。
 *
 * PII を一切扱わない（来訪者の氏名/会社名/メモ等の値はここに持ち込まない）。
 */

import {
  RECEPTION_STATES,
  type ReceptionEvent,
  type ReceptionState,
  transition,
} from './state';

// 契約モジュールの消費側（#121/#122/#123）が screenState 型を 1 箇所から import できるよう再エクスポート。
export type { ReceptionState } from './state';

/**
 * 受付UXのアクション（来訪者が起こせる操作）。
 *
 * 既存 state.ts の `ReceptionEvent` のうち、UI 上で「来訪者が能動的に起こす操作」だけを
 * 抜き出した語彙。`CALL_CONNECTED` / `CALL_TIMEOUT` / `CALL_FAILED` のような外部シグナル
 * 由来のイベントは UI アクションではないため含めない（システム遷移として state.ts が扱う）。
 */
export const RECEPTION_ACTIONS = [
  'start', // 受付開始（待機 → 目的選択）
  'selectPurpose', // 目的を選ぶ
  'selectTarget', // 担当者/部署を選ぶ
  'submitVisitorInfo', // 来訪者情報を入力して確認へ
  'confirm', // 確認画面で呼び出しを確定（重要操作）
  'cancel', // キャンセル
  'back', // 一つ前の画面へ
  'useFallback', // 失敗/未応答から代替導線へ
  'complete', // 完了
  'reset', // 待機へ戻す
] as const;

export type ReceptionAction = (typeof RECEPTION_ACTIONS)[number];

/**
 * UI アクション → state.ts のイベント への写像。
 * UI 契約は「状態の所有者」ではないため、許可判定は必ずこの写像越しに
 * `transition` へ委譲する（state.ts と二重定義しない＝矛盾しない）。
 */
const ACTION_TO_EVENT: Record<ReceptionAction, ReceptionEvent> = {
  start: 'START',
  selectPurpose: 'SELECT_PURPOSE',
  selectTarget: 'SELECT_TARGET',
  submitVisitorInfo: 'SUBMIT_VISITOR_INFO',
  confirm: 'CONFIRM',
  cancel: 'CANCEL',
  back: 'BACK',
  useFallback: 'USE_FALLBACK',
  complete: 'COMPLETE',
  reset: 'RESET',
};

/**
 * 「自由文（チャット/LLM）だけでは確定させない」重要操作。
 *
 * これらは確認画面（confirming）を必ず経由した上での明示操作としてのみ許す。
 *  - confirm: 呼び出し確定。confirming 状態からのみ実行できる。
 *  - submitVisitorInfo: 個人情報確定。確定先は confirming（＝必ず確認を挟む）。
 */
export const REQUIRES_CONFIRMATION_ACTIONS: ReadonlySet<ReceptionAction> = new Set<ReceptionAction>(
  ['confirm', 'submitVisitorInfo'],
);

/**
 * チャット/LLM から「直接」起動してはならない操作。
 *
 * 重要操作（呼び出し確定・個人情報確定）に加え、状態を巻き戻す/破棄する破壊的操作も
 * チャット主導での即時実行を禁じる。チャットはこれらをタッチUIの確認操作へ「誘導」する
 * ことはできるが、自分で確定はできない。
 */
export const CHAT_FORBIDDEN_ACTIONS: ReadonlySet<ReceptionAction> = new Set<ReceptionAction>([
  'confirm',
  'submitVisitorInfo',
]);

/**
 * アバターの状態。screenState から純粋に導出する（state は持たない）。
 * 役割は「受付状態を伝える案内役」。発話/字幕/モーションはこの値に従う。
 */
export const AVATAR_STATES = [
  'idle', // 待機・呼びかけ
  'greeting', // 受付開始直後の挨拶
  'guiding', // 目的/担当選択などの操作案内
  'listening', // 来訪者情報入力中（傾聴姿勢）
  'confirming', // 確認を促す
  'calling', // 呼び出し中の安心案内
  'connected', // 通話中（控えめ）
  'apologizing', // 失敗/未応答のお詫び・代替案内
  'farewell', // 完了の見送り
] as const;

export type AvatarState = (typeof AVATAR_STATES)[number];

/**
 * screenState → avatarState の写像。全 screenState を網羅する（漏れは型で検出）。
 */
const SCREEN_TO_AVATAR: Record<ReceptionState, AvatarState> = {
  idle: 'idle',
  selectingPurpose: 'greeting',
  selectingTarget: 'guiding',
  inputVisitorInfo: 'listening',
  confirming: 'confirming',
  calling: 'calling',
  connected: 'connected',
  failed: 'apologizing',
  timeout: 'apologizing',
  cancelled: 'farewell',
  fallback: 'guiding',
  completed: 'farewell',
};

/** チャットドロワーの開閉/利用可否。screenState から導出する。 */
export type ChatAvailability = 'available' | 'unavailable';

/**
 * 通話状態。session.callOutcome（connected/timeout/failed/cancelled）とは別に、
 * 「今この画面が通話に関してどういう局面か」を screenState から導出した値。
 *  - none: 通話に未着手
 *  - dialing: 呼び出し中
 *  - connected: 通話中
 *  - ended: 通話が成功裏に終わった（completed）
 *  - failed: 失敗/未応答/キャンセルで通話に至らず終わった
 */
export const CALL_STATUSES = ['none', 'dialing', 'connected', 'ended', 'failed'] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

const SCREEN_TO_CALL_STATUS: Record<ReceptionState, CallStatus> = {
  idle: 'none',
  selectingPurpose: 'none',
  selectingTarget: 'none',
  inputVisitorInfo: 'none',
  confirming: 'none',
  calling: 'dialing',
  connected: 'connected',
  failed: 'failed',
  timeout: 'failed',
  cancelled: 'failed',
  fallback: 'failed',
  completed: 'ended',
};

/**
 * プライバシー局面。画面に PII 入力フォームを出している/PII を保持しうる局面かを示す。
 *  - none: PII を扱っていない
 *  - collecting: PII を入力中（明示の注意書きが要る局面）
 *  - retained: PII を確定保持し、確認/通話で利用している局面
 */
export const PRIVACY_STATES = ['none', 'collecting', 'retained'] as const;
export type PrivacyState = (typeof PRIVACY_STATES)[number];

const SCREEN_TO_PRIVACY: Record<ReceptionState, PrivacyState> = {
  idle: 'none',
  selectingPurpose: 'none',
  selectingTarget: 'none',
  inputVisitorInfo: 'collecting',
  confirming: 'retained',
  calling: 'retained',
  connected: 'retained',
  failed: 'retained',
  timeout: 'retained',
  cancelled: 'none',
  fallback: 'retained',
  completed: 'none',
};

/**
 * その screenState で「来訪者が起こせる操作（許可済みアクション）」の集合。
 *
 * 唯一の真実源は state.ts の `transition`。ここで二重定義はせず、各 UI アクションを
 * イベントへ写像し、現状態から有効な遷移があるものだけを許可する。これにより state.ts と
 * 必ず整合し、状態遷移表の変更に追従する。
 */
export function availableActions(state: ReceptionState): ReadonlySet<ReceptionAction> {
  const allowed = new Set<ReceptionAction>();
  for (const action of RECEPTION_ACTIONS) {
    if (transition(state, ACTION_TO_EVENT[action]) !== null) {
      allowed.add(action);
    }
  }
  return allowed;
}

/** その状態でそのアクションが許可されているか（タッチUI/チャット共通の入口）。 */
export function isActionAllowed(state: ReceptionState, action: ReceptionAction): boolean {
  return transition(state, ACTION_TO_EVENT[action]) !== null;
}

/**
 * チャット/LLM から起動してよいアクションか。
 *
 * 二段構え:
 *  1. そもそも screenState で許可されている（availableActions に含まれる）こと。
 *  2. チャット禁止集合（重要操作: 呼び出し確定・個人情報確定）に含まれないこと。
 *
 * これにより「自由文だけで重要操作を確定させない」不変条件を関数で担保する。
 */
export function isChatActionAllowed(state: ReceptionState, action: ReceptionAction): boolean {
  if (CHAT_FORBIDDEN_ACTIONS.has(action)) {
    return false;
  }
  return isActionAllowed(state, action);
}

/**
 * 重要操作が「確認を経由しているか」の不変条件チェック。
 *
 * confirm / submitVisitorInfo は、それぞれ confirming へ向かう/から発する操作としてのみ
 * 成立する。state.ts の遷移表上、
 *  - confirm は confirming からのみ calling へ進める
 *  - submitVisitorInfo は inputVisitorInfo からのみ confirming へ進む（＝確認を必ず挟む）
 * よって「許可されている」こと自体が確認経由を保証する。本関数はその不変条件を明示的に
 * 検証する（呼び出し側のアサーション/テスト用）。
 */
export function passesConfirmationInvariant(
  state: ReceptionState,
  action: ReceptionAction,
): boolean {
  if (!REQUIRES_CONFIRMATION_ACTIONS.has(action)) {
    return true;
  }
  if (action === 'confirm') {
    // 呼び出し確定は confirming からのみ。
    return state === 'confirming' && isActionAllowed(state, action);
  }
  // 個人情報確定は inputVisitorInfo からのみ（確定先が confirming）。
  return state === 'inputVisitorInfo' && transition(state, 'SUBMIT_VISITOR_INFO') === 'confirming';
}

/** screenState から avatarState を純粋に導出する。 */
export function deriveAvatarState(state: ReceptionState): AvatarState {
  return SCREEN_TO_AVATAR[state];
}

/** screenState から通話状態を導出する。 */
export function deriveCallStatus(state: ReceptionState): CallStatus {
  return SCREEN_TO_CALL_STATUS[state];
}

/** screenState からプライバシー局面を導出する。 */
export function derivePrivacyState(state: ReceptionState): PrivacyState {
  return SCREEN_TO_PRIVACY[state];
}

/**
 * チャットドロワーの利用可否を導出する。
 * Chat-assisted の方針上、受付が「進行中」の局面では補助として開けるが、待機/終端では閉じる。
 */
export function deriveChatAvailability(state: ReceptionState): ChatAvailability {
  const closedStates: ReadonlySet<ReceptionState> = new Set<ReceptionState>([
    'idle',
    'cancelled',
    'completed',
  ]);
  return closedStates.has(state) ? 'unavailable' : 'available';
}

/**
 * チャットメッセージ（補助パネルの表示用・最小スキーマ）。
 * PII を保持しないこと（来訪者の自由入力をそのまま長期保持しない）。表示用途の最小型。
 */
export type ChatRole = 'visitor' | 'assistant' | 'system';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  /**
   * このメッセージがアシスタントから提案する許可済みアクション（任意）。
   * チャットは確定ではなく「タッチUIの操作への誘導」を提案する。重要操作は提案できても
   * 自動確定はしない（isChatActionAllowed で弾く）。
   */
  suggestedAction?: ReceptionAction;
  createdAt: string;
};

/**
 * 来訪者入力の最小状態。PII の値は保持しない（入力中フラグ/対象フィールドのみ）。
 */
export type VisitorInputState = {
  /** 現在どのフィールドにフォーカスしているか（任意・表示制御用）。 */
  activeField?: 'name' | 'company' | 'note';
  /** 入力中かどうか（アバターの listening 表現などに使う）。 */
  isEditing: boolean;
};

/**
 * 受付UXの統合契約。タッチUI/チャットUI/アバターはこの 1 つを参照する。
 *
 * `screenState` を唯一の真実源とし、`avatarState` / `availableActions` / `callStatus` /
 * `privacyState` / `chatAvailability` はそこから導出された値。`chatMessages` / `visitorInput`
 * は UI 層が保持する補助状態（契約としては型のみ定義）。
 */
export type ReceptionUiContract = {
  screenState: ReceptionState;
  avatarState: AvatarState;
  availableActions: ReadonlySet<ReceptionAction>;
  callStatus: CallStatus;
  privacyState: PrivacyState;
  chatAvailability: ChatAvailability;
  chatMessages: ReadonlyArray<ChatMessage>;
  visitorInput: VisitorInputState;
};

/**
 * screenState（+ UI 層の補助状態）から統合契約を組み立てる純関数。
 * 導出値は必ずこの 1 箇所で計算し、UI 各所が個別に再計算してズレるのを防ぐ。
 */
export function buildUiContract(
  state: ReceptionState,
  ui?: {
    chatMessages?: ReadonlyArray<ChatMessage>;
    visitorInput?: VisitorInputState;
  },
): ReceptionUiContract {
  return {
    screenState: state,
    avatarState: deriveAvatarState(state),
    availableActions: availableActions(state),
    callStatus: deriveCallStatus(state),
    privacyState: derivePrivacyState(state),
    chatAvailability: deriveChatAvailability(state),
    chatMessages: ui?.chatMessages ?? [],
    visitorInput: ui?.visitorInput ?? { isEditing: false },
  };
}

/** 全 screenState（再エクスポート。契約の網羅テスト/イテレーション用）。 */
export { RECEPTION_STATES };
