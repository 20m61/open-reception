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
import {
  transition as checkinTransition,
  type CheckinEvent,
  type CheckinState,
} from '@/domain/checkin/state';
import { motionKeyForState, type MotionKey } from '@/domain/motion/types';
import { RECEPTION_PURPOSES } from './session';

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

// =============================================================================
// #361 Character-led: ConversationTurnView 契約
// -----------------------------------------------------------------------------
// 目的: 各 ReceptionState を「同じアバターとの 1 つの会話ターン」として提示するための
// 状態駆動写像。選択・入力画面でもアバターとの対話が途切れないよう、アバターの在り方
// (presence)・表情・視線・字幕・回答候補・入力手段・確認要否・逃げ道を 1 箇所で導出する。
//
// 設計原則（本ファイル冒頭の原則を継承）:
//  - 状態の所有者は state.ts。本契約は screenState から導出するだけ。
//  - 表示契約の真実源は本モジュールに一本化する（#361 AC「ui-contract.ts 以外に競合する
//    表示契約の真実源を作らない」）。emotion 語彙は avatar/guidance.ts の expression と一致
//    させ（テストで担保）、motionKey は #31 の motionKeyForState を再利用する（二重化しない）。
//  - locale 依存の表示文字列（displayText/answers ラベル）は component 層で解決して注入できる
//    （domain → component への逆依存を避けるため、既定は ja の意味論的文言を内蔵する）。
//  - PII を持ち込まない。
// =============================================================================

/**
 * アバターの在り方。screenState から導出する。
 *  - primary: 待機・ウェルカム。アバターが画面の主役（ヒーロー表示）。
 *  - companion: 選択/入力/確認/呼び出し/結果。操作の傍らで対話を継続する付き添い。
 *  - minimal: 通話中。キャラクターは発話を止め、静かな待機姿勢へ退く（#361 レイアウト方針）。
 */
export const AVATAR_PRESENCES = ['primary', 'companion', 'minimal'] as const;
export type AvatarPresence = (typeof AVATAR_PRESENCES)[number];

const SCREEN_TO_PRESENCE: Record<ReceptionState, AvatarPresence> = {
  idle: 'primary',
  selectingPurpose: 'companion',
  selectingTarget: 'companion',
  inputVisitorInfo: 'companion',
  confirming: 'companion',
  calling: 'companion',
  connected: 'minimal',
  failed: 'companion',
  timeout: 'companion',
  cancelled: 'companion',
  fallback: 'companion',
  completed: 'companion',
};

/** screenState からアバターの在り方(presence)を導出する。 */
export function deriveAvatarPresence(state: ReceptionState): AvatarPresence {
  return SCREEN_TO_PRESENCE[state];
}

/**
 * アバターの表情(emotion)。表示契約としての真実源はここに置く。
 * avatar/guidance.ts の `AvatarExpression` と同一語彙で、`deriveAvatarEmotion` の値は
 * guidance の expression と一致する（ui-contract.test.ts が cross-check で担保）。
 */
export const AVATAR_EMOTIONS = ['neutral', 'happy', 'relaxed', 'thinking', 'concerned'] as const;
export type AvatarEmotion = (typeof AVATAR_EMOTIONS)[number];

/** avatarState → emotion（guidance.ts の PRESENTATION 表情と一致させる）。 */
const AVATAR_STATE_TO_EMOTION: Record<AvatarState, AvatarEmotion> = {
  idle: 'happy',
  greeting: 'happy',
  guiding: 'neutral',
  listening: 'relaxed',
  confirming: 'thinking',
  calling: 'relaxed',
  connected: 'happy',
  apologizing: 'concerned',
  farewell: 'happy',
};

/** screenState からアバターの表情(emotion)を導出する（avatarState 経由）。 */
export function deriveAvatarEmotion(state: ReceptionState): AvatarEmotion {
  return AVATAR_STATE_TO_EMOTION[deriveAvatarState(state)];
}

/**
 * 視線誘導先(gazeTarget)。次に触れるべき場所へ軽く視線を向ける意味論的ヒント。
 * 実際の VRM 視線適用は #65。'none' は誘導なし（操作を急かさない局面）。
 */
export const GAZE_TARGETS = ['none', 'answers', 'form', 'confirmCta', 'fallbackCta'] as const;
export type GazeTarget = (typeof GAZE_TARGETS)[number];

const SCREEN_TO_GAZE: Record<ReceptionState, GazeTarget> = {
  idle: 'answers',
  selectingPurpose: 'answers',
  selectingTarget: 'answers',
  inputVisitorInfo: 'form',
  confirming: 'confirmCta',
  calling: 'none',
  connected: 'none',
  failed: 'fallbackCta',
  timeout: 'fallbackCta',
  cancelled: 'none',
  fallback: 'answers',
  completed: 'none',
};

/** screenState から視線誘導先を導出する。 */
export function gazeTargetFor(state: ReceptionState): GazeTarget {
  return SCREEN_TO_GAZE[state];
}

/**
 * メッセージの意味論キー(MessageKey)。画面表示文と発話文はこのキーを共有し、
 * 人名の読み・丁寧表現のため displayText / speechText を分離できる（#361）。
 */
export const MESSAGE_KEYS = [
  'welcome',
  'choosePurpose',
  'chooseTarget',
  'enterVisitorInfo',
  'reviewAndConfirm',
  'calling',
  'connected',
  'apologyTimeout',
  'apologyFailed',
  'fallbackGuidance',
  'farewell',
  'cancelled',
] as const;
export type MessageKey = (typeof MESSAGE_KEYS)[number];

const SCREEN_TO_MESSAGE_KEY: Record<ReceptionState, MessageKey> = {
  idle: 'welcome',
  selectingPurpose: 'choosePurpose',
  selectingTarget: 'chooseTarget',
  inputVisitorInfo: 'enterVisitorInfo',
  confirming: 'reviewAndConfirm',
  calling: 'calling',
  connected: 'connected',
  failed: 'apologyFailed',
  timeout: 'apologyTimeout',
  cancelled: 'cancelled',
  fallback: 'fallbackGuidance',
  completed: 'farewell',
};

/** screenState からメッセージ意味論キーを導出する。 */
export function messageKeyForState(state: ReceptionState): MessageKey {
  return SCREEN_TO_MESSAGE_KEY[state];
}

/**
 * ターン既定の表示文言（ja・意味論的短文）。component 層が locale 解決した値を注入しない
 * 場合のフォールバック。avatar/guidance.ts の字幕（人格・挨拶＋声掛け）とは別スロットで、
 * こちらは「その画面の主指示（見出し相当）」を意味論キーから供給する（#324 の役割分担）。
 */
const MESSAGE_TEXT_JA: Record<MessageKey, string> = {
  welcome: 'ようこそ。ご用件をお選びください',
  choosePurpose: 'ご用件の種類をお選びください',
  chooseTarget: 'お訪ねする担当者・部署をお選びください',
  enterVisitorInfo: 'お名前などをご入力ください',
  reviewAndConfirm: '内容をご確認のうえ、お呼び出しください',
  calling: '担当者を呼び出しています。少々お待ちください',
  connected: 'おつなぎしました。担当者がまいります',
  apologyTimeout: 'ただ今応答がありません。別の方法をご案内します',
  apologyFailed: 'おつなぎできませんでした。別の方法をご案内します',
  fallbackGuidance: '代わりのご連絡方法をご案内します',
  farewell: '受付が完了しました。ご案内をお待ちください',
  cancelled: '受付を中止しました',
};

/**
 * ターンの入力手段(InputMode)。タッチ・音声・文字・QR を同一質問への入力手段として扱う。
 * タッチは全ターンで必ず提示する（音声/VRM/STT が失敗してもタッチだけで完走できる不変条件）。
 */
export const INPUT_MODES = ['touch', 'voice', 'text', 'qr'] as const;
export type InputMode = (typeof INPUT_MODES)[number];

const SCREEN_TO_INPUT_MODES: Record<ReceptionState, ReadonlyArray<InputMode>> = {
  // 待機は QR 受付の入口を併記する（読み取りだけで発信しない導線: qr-scan→qr-confirm→calling）。
  idle: ['touch', 'qr'],
  selectingPurpose: ['touch', 'voice', 'text'],
  selectingTarget: ['touch', 'voice', 'text'],
  inputVisitorInfo: ['touch', 'voice', 'text'],
  // 発信・個人情報確定は必ずタッチ確認のみ（音声だけで発信されない）。
  confirming: ['touch'],
  calling: ['touch'],
  connected: ['touch'],
  failed: ['touch'],
  timeout: ['touch'],
  cancelled: ['touch'],
  fallback: ['touch'],
  completed: ['touch'],
};

/** screenState からそのターンで受け付ける入力手段を導出する。 */
export function inputModesFor(state: ReceptionState): ReadonlyArray<InputMode> {
  return SCREEN_TO_INPUT_MODES[state];
}

/**
 * そのターンが発信/個人情報送信の明示タッチ確認を要するか。
 * REQUIRES_CONFIRMATION_ACTIONS（confirm / submitVisitorInfo）が許可されている状態＝
 * inputVisitorInfo（個人情報送信）と confirming（発信確定）で true。
 */
export function requiresExplicitConfirmationFor(state: ReceptionState): boolean {
  const allowed = availableActions(state);
  for (const action of REQUIRES_CONFIRMATION_ACTIONS) {
    if (allowed.has(action)) return true;
  }
  return false;
}

/**
 * ターン契約における逃げ道（意味論）。表示ラベル/強調度は component 層（quick-actions.ts の
 * EscapeHatch）が担い、ここでは「どの後退アクションが許可されるか」だけを持つ。
 */
export type EscapeHatch = { action: ReceptionAction };

const ESCAPE_HATCH_ACTIONS: ReadonlyArray<ReceptionAction> = ['back', 'reset'];

/**
 * そのターンで提示する逃げ道アクション（back/reset のうち availableActions にあるもの）。
 * idle は入口画面で戻る先が無いため出さない。
 */
export function escapeHatchActionsFor(state: ReceptionState): ReadonlyArray<EscapeHatch> {
  if (state === 'idle') return [];
  const allowed = availableActions(state);
  return ESCAPE_HATCH_ACTIONS.filter((action) => allowed.has(action)).map((action) => ({ action }));
}

/** 会話ターンの回答候補（タッチ/音声/文字いずれの入力でも同じ intent へ収束させる）。 */
export type ConversationAnswer = {
  id: string;
  label: string;
  /** 選択時に起こす許可済みアクション（既定 answers は必ず availableActions の部分集合）。 */
  intent: ReceptionAction;
};

/**
 * ターン既定の回答候補（ja ラベル・静的な分だけ）。担当者/部署のような実行時リストは空にし、
 * component 層が `conversationTurnFor(state, { answers })` で注入する。
 */
function defaultAnswersFor(state: ReceptionState): ReadonlyArray<ConversationAnswer> {
  switch (state) {
    case 'selectingPurpose':
      return RECEPTION_PURPOSES.map((p) => ({ id: p.id, label: p.label, intent: 'selectPurpose' }));
    case 'confirming':
      return [{ id: 'confirm', label: 'この内容で呼ぶ', intent: 'confirm' }];
    case 'timeout':
    case 'failed':
      return [{ id: 'fallback', label: '別の方法でご連絡', intent: 'useFallback' }];
    case 'connected':
      return [{ id: 'complete', label: '受付を終了', intent: 'complete' }];
    case 'fallback':
      return [{ id: 'complete', label: '受付を終了', intent: 'complete' }];
    default:
      // idle（クイックアクションが入口）/ selectingTarget・inputVisitorInfo（実行時リスト・フォーム）/
      // calling / completed / cancelled は既定の静的回答を持たない。
      return [];
  }
}

/**
 * ConversationTurnView（#361）。タッチUI/アバター/字幕/音声/QR がこの 1 つを参照し、
 * 「今どのターンで、何を聞かれ、どう答え/戻れるか」を状態から一貫して導出する。
 */
export type ConversationTurnView = {
  stateKey: ReceptionState;
  avatar: {
    presence: AvatarPresence;
    emotion: AvatarEmotion;
    motionKey: MotionKey;
    gazeTarget?: GazeTarget;
  };
  message: {
    semanticKey: MessageKey;
    displayText: string;
    /** 発話専用文（読み・丁寧表現のため displayText と分離可能）。省略時は displayText を読む。 */
    speechText?: string;
    /** このターンでアバターが発話するか（通話中 connected は false: 静かな待機姿勢）。 */
    speak: boolean;
  };
  answers: ReadonlyArray<ConversationAnswer>;
  inputModes: ReadonlyArray<InputMode>;
  requiresExplicitConfirmation: boolean;
  escapeHatches: ReadonlyArray<EscapeHatch>;
};

/** 通話中はアバターが発話を止める（#361 レイアウト方針）。 */
const NON_SPEAKING_STATES: ReadonlySet<ReceptionState> = new Set<ReceptionState>(['connected']);

/**
 * screenState（+ component 層が locale 解決した表示値）から ConversationTurnView を組み立てる純関数。
 *
 * `overrides.message` を渡すと displayText/speechText を差し替え（多言語や人名読みの反映）、
 * `overrides.answers` を渡すと回答候補を差し替える（担当者/部署の実行時リストの注入）。
 * いずれも省略時は ja の意味論的既定値を使う。domain は component へ依存しない。
 */
export function conversationTurnFor(
  state: ReceptionState,
  overrides?: {
    message?: { displayText: string; speechText?: string };
    answers?: ReadonlyArray<ConversationAnswer>;
  },
): ConversationTurnView {
  const semanticKey = messageKeyForState(state);
  const gazeTarget = gazeTargetFor(state);
  return {
    stateKey: state,
    avatar: {
      presence: deriveAvatarPresence(state),
      emotion: deriveAvatarEmotion(state),
      motionKey: motionKeyForState(state),
      // 'none' は誘導なしなので gazeTarget を省く（issue の型は optional）。
      ...(gazeTarget === 'none' ? {} : { gazeTarget }),
    },
    message: {
      semanticKey,
      displayText: overrides?.message?.displayText ?? MESSAGE_TEXT_JA[semanticKey],
      ...(overrides?.message?.speechText !== undefined
        ? { speechText: overrides.message.speechText }
        : {}),
      speak: !NON_SPEAKING_STATES.has(state),
    },
    answers: overrides?.answers ?? defaultAnswersFor(state),
    inputModes: inputModesFor(state),
    requiresExplicitConfirmation: requiresExplicitConfirmationFor(state),
    escapeHatches: escapeHatchActionsFor(state),
  };
}

/** 全 screenState（再エクスポート。契約の網羅テスト/イテレーション用）。 */
export { RECEPTION_STATES };

// =============================================================================
// #361 QR 受付シェル統一: CheckinState を会話ターンとして提示する契約
// -----------------------------------------------------------------------------
// 目的: QR 受付(CheckinFlow, domain/checkin/state.ts)を、通常受付(KioskFlow)と「同じ
// アバター継続レール・字幕・逃げ道シェル」で提示し、別アプリに見せない。
//
// 設計原則（本ファイル冒頭の原則を継承）:
//  - 進行の真実源は domain/checkin/state.ts（状態機械）。本契約はそこから「導出」するだけで
//    独自に状態を進めない。発信(calling)へ進めるのは confirming の CONFIRM のみ、という不変
//    条件は状態機械に紐づけて表現する（checkinRequiresExplicitConfirmation）。
//  - 表示契約の真実源は ui-contract.ts に一本化する（#361 AC「競合する表示契約の真実源を作らない」）。
//  - アバターの見た目(表情/モーション/在り方)は ReceptionState 代理経由で導出し、既存の
//    AvatarGuide（ReceptionState 駆動）をそのまま再利用する（受付とキャラクターを共有する）。
//  - locale 依存の字幕は component 層が解決して注入できる（既定は ja の意味論的文言を内蔵）。
//  - PII を持ち込まない（来訪者の氏名/会社名等の値はここに持ち込まない）。
// =============================================================================

/**
 * CheckinState → アバター視覚のための ReceptionState 代理。
 * QR 受付でも通常受付と同じアバター/表情/モーション/字幕枠を共有するため、checkin の各状態を
 * 意味論的に最も近い受付状態へ写す。進行そのものは checkin 状態機械が所有し、これは表示専用。
 */
const CHECKIN_TO_RECEPTION_PROXY: Record<CheckinState, ReceptionState> = {
  idle: 'idle', // 入口・ヒーロー
  selectingMethod: 'selectingPurpose', // 方法を選ぶ（挨拶して選択を促す）
  checkingCamera: 'selectingTarget', // カメラ許可の案内（操作案内）
  scanning: 'inputVisitorInfo', // 読み取り待ち（傾聴姿勢）
  resolving: 'confirming', // 予約確認中（思案）
  confirming: 'confirming', // 予約内容の確認（思案・確認CTAへ誘導）
  calling: 'calling', // 呼び出し中（安心案内）
  completed: 'completed', // 完了（お見送り）
  cancelled: 'cancelled', // 中止（お見送り）
  manualFallback: 'fallback', // 通常受付へ切替（代替案内）
  cameraError: 'failed', // 以下エラーはお詫び・代替案内
  scanError: 'failed',
  expiredError: 'failed',
  usedError: 'failed',
  revokedError: 'failed',
  networkError: 'failed',
};

/** CheckinState を、アバター表示のための ReceptionState 代理へ写す。 */
export function checkinAvatarProxyState(state: CheckinState): ReceptionState {
  return CHECKIN_TO_RECEPTION_PROXY[state];
}

/**
 * QR 受付の字幕・案内の意味論キー。画面表示文とアバター字幕はこのキーを共有し、
 * 通常受付(MessageKey)と混同しないよう別語彙で持つ。
 */
export const CHECKIN_MESSAGE_KEYS = [
  'intro', // idle: QR 受付の入口案内
  'chooseMethod', // selectingMethod: QR / 通常受付の選択
  'cameraPermission', // checkingCamera: カメラ許可の案内
  'scanning', // scanning: 読み取り中（qr-scan ターン）
  'resolving', // resolving: 予約確認中
  'reviewReservation', // confirming: 予約内容の確認（qr-confirm ターン）
  'calling', // calling: 呼び出し中
  'completed', // completed: 受付完了
  'cancelled', // cancelled: 受付中止
  'manualFallback', // manualFallback: 通常受付へ切替
  'cameraError', // 以下エラー種別
  'scanError',
  'expiredError',
  'usedError',
  'revokedError',
  'networkError',
] as const;
export type CheckinMessageKey = (typeof CHECKIN_MESSAGE_KEYS)[number];

const CHECKIN_STATE_TO_MESSAGE_KEY: Record<CheckinState, CheckinMessageKey> = {
  idle: 'intro',
  selectingMethod: 'chooseMethod',
  checkingCamera: 'cameraPermission',
  scanning: 'scanning',
  resolving: 'resolving',
  confirming: 'reviewReservation',
  calling: 'calling',
  completed: 'completed',
  cancelled: 'cancelled',
  manualFallback: 'manualFallback',
  cameraError: 'cameraError',
  scanError: 'scanError',
  expiredError: 'expiredError',
  usedError: 'usedError',
  revokedError: 'revokedError',
  networkError: 'networkError',
};

/** CheckinState から字幕の意味論キーを導出する。 */
export function checkinMessageKeyFor(state: CheckinState): CheckinMessageKey {
  return CHECKIN_STATE_TO_MESSAGE_KEY[state];
}

/**
 * QR 受付の既定字幕（ja・意味論的短文）。component 層が locale 解決した値を注入しない場合の
 * フォールバック。画面文言・音声・字幕が矛盾しないよう、CheckinFlow の主導線に整合させる。
 */
const CHECKIN_MESSAGE_TEXT_JA: Record<CheckinMessageKey, string> = {
  intro: '予約 QR をお持ちの方はこちらから受付できます',
  chooseMethod: '受付方法をお選びください',
  cameraPermission: 'QR を読み取るためにカメラの使用を許可してください',
  scanning: '予約 QR をカメラにかざしてください',
  resolving: 'ご予約を確認しています。少々お待ちください',
  reviewReservation: 'ご予約内容をご確認のうえ、お呼び出しください',
  calling: '担当者を呼び出しています。少々お待ちください',
  completed: '受付が完了しました。ご案内をお待ちください',
  cancelled: '受付を中止しました',
  manualFallback: '通常受付に切り替えます。手入力でお進みください',
  cameraError: 'カメラを使用できませんでした。通常受付でお進みいただけます',
  scanError: 'QR を読み取れませんでした。もう一度お試しか、通常受付をご利用ください',
  expiredError: 'この QR は有効期限が切れています。受付スタッフにお問い合わせください',
  usedError: 'この QR はすでに受付に使用されています。受付スタッフにお問い合わせください',
  revokedError: 'この QR は無効化されています。受付スタッフにお問い合わせください',
  networkError: '通信に失敗しました。通常受付でお進みいただけます',
};

/**
 * CheckinState ごとの入力手段。タッチは全ターンで必ず提示する（音声/QR/カメラが失敗しても
 * タッチだけで完走できる不変条件）。QR は読み取り(scanning)の読み取り専用チャネルとしてのみ
 * 併記し、発信確定(confirming)には含めない（音声/QR だけで発信させない）。
 */
const CHECKIN_STATE_TO_INPUT_MODES: Record<CheckinState, ReadonlyArray<InputMode>> = {
  idle: ['touch'],
  selectingMethod: ['touch'],
  checkingCamera: ['touch'],
  scanning: ['touch', 'qr'], // 読み取りだけ。タッチでいつでも中断/通常受付へ。
  resolving: ['touch'],
  confirming: ['touch'], // 発信確定はタッチのみ
  calling: ['touch'],
  completed: ['touch'],
  cancelled: ['touch'],
  manualFallback: ['touch'],
  cameraError: ['touch'],
  scanError: ['touch'],
  expiredError: ['touch'],
  usedError: ['touch'],
  revokedError: ['touch'],
  networkError: ['touch'],
};

/** CheckinState からそのターンで受け付ける入力手段を導出する。 */
export function checkinInputModesFor(state: CheckinState): ReadonlyArray<InputMode> {
  return CHECKIN_STATE_TO_INPUT_MODES[state];
}

/**
 * そのターンが発信（担当者呼び出し）の明示タッチ確認を要するか。
 *
 * 「QR は読み取りだけで発信しない」不変条件を状態機械に紐づけて表現する: 発信(calling)へ進む
 * のは confirming の CONFIRM のみ。読み取り(scanning)/取得(resolving)からは calling へ進めない
 * ため false になる（二重定義せず checkin 状態機械へ委譲）。
 */
export function checkinRequiresExplicitConfirmation(state: CheckinState): boolean {
  return checkinTransition(state, 'CONFIRM') === 'calling';
}

/** QR 受付シェルの逃げ道（後退・切替）。表示ラベルは component 層が担う。 */
export type CheckinEscapeHatch = { event: CheckinEvent };

/**
 * 逃げ道として提示しうるイベント（後退・通常受付への切替・待機へリセット）。
 * どれを実際に出すかは状態機械の許可に従う（存在しない遷移は出さない）。
 */
const CHECKIN_ESCAPE_EVENTS: ReadonlyArray<CheckinEvent> = [
  'CHOOSE_MANUAL', // 受付方法選択から通常受付へ
  'USE_MANUAL', // エラーから通常受付へ
  'CANCEL', // 中断
  'RESET', // 最初に戻る（全状態から待機へ）
];

/**
 * そのターンで提示する逃げ道イベント。idle は入口で戻る先が無いため出さない。RESET は
 * 状態機械上どの状態からも idle へ戻せる安全弁のため常に許可する（idle を除く）。それ以外は
 * `checkinTransition` が非 null を返すものだけを出す（許可外は出さない）。
 */
export function checkinEscapeHatchesFor(state: CheckinState): ReadonlyArray<CheckinEscapeHatch> {
  if (state === 'idle') return [];
  return CHECKIN_ESCAPE_EVENTS.filter((event) =>
    event === 'RESET' ? true : checkinTransition(state, event) !== null,
  ).map((event) => ({ event }));
}

/**
 * QR 受付の会話ターン（#361）。CheckinFlow の各画面がこの 1 つを参照し、通常受付と同じ
 * アバター継続レール・字幕・逃げ道シェルで提示する。
 */
export type CheckinTurnView = {
  stateKey: CheckinState;
  avatar: {
    presence: AvatarPresence;
    emotion: AvatarEmotion;
    motionKey: MotionKey;
    /** アバター表示のための ReceptionState 代理（AvatarGuide 再利用のため）。 */
    proxyState: ReceptionState;
  };
  message: {
    semanticKey: CheckinMessageKey;
    displayText: string;
    /** このターンでアバターが発話するか（QR 受付に通話中の無発話局面は無く常に true）。 */
    speak: boolean;
  };
  inputModes: ReadonlyArray<InputMode>;
  requiresExplicitConfirmation: boolean;
  escapeHatches: ReadonlyArray<CheckinEscapeHatch>;
};

/**
 * CheckinState（+ component 層が locale 解決した字幕）から CheckinTurnView を組み立てる純関数。
 * `overrides.message.displayText` を渡すと字幕を差し替え（多言語対応）。省略時は ja 既定値。
 */
export function checkinConversationTurnFor(
  state: CheckinState,
  overrides?: {
    message?: { displayText: string };
  },
): CheckinTurnView {
  const proxyState = checkinAvatarProxyState(state);
  const semanticKey = checkinMessageKeyFor(state);
  return {
    stateKey: state,
    avatar: {
      presence: deriveAvatarPresence(proxyState),
      emotion: deriveAvatarEmotion(proxyState),
      motionKey: motionKeyForState(proxyState),
      proxyState,
    },
    message: {
      semanticKey,
      displayText: overrides?.message?.displayText ?? CHECKIN_MESSAGE_TEXT_JA[semanticKey],
      speak: true,
    },
    inputModes: checkinInputModesFor(state),
    requiresExplicitConfirmation: checkinRequiresExplicitConfirmation(state),
    escapeHatches: checkinEscapeHatchesFor(state),
  };
}
