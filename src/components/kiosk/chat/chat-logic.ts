/**
 * Chat-assisted ドロワーの純ロジック (issue #122 / Epic #119)。
 *
 * 役割: LLM（adapter）の出力を「タッチ可能な許可済みクイックリプライ」へ安全に変換する。
 * UI（KioskChatDrawer.tsx）はこの純関数群を呼ぶだけで、変換・許可判定・フォールバックを
 * 自前で持たない。これにより不変条件をテストで担保できる。
 *
 * 不変条件（テストで検証）:
 *  1. チャットから提示できる実行アクションは ui-contract の `isChatActionAllowed` を通った
 *     ものだけ（= availableActions に含まれ、かつ chat 禁止集合に無いもの）。
 *  2. `confirm` / `submitVisitorInfo`（呼び出し確定・個人情報確定）はチャットから確定できない。
 *     候補としても「実行」ではなく「タッチ確認への誘導（needsTouchConfirm）」に降格させる。
 *  3. 自由文の結果を直接実行しない。すべて候補（quick reply）に変換し、タッチを必須にする。
 *  4. オフライン/LLM 失敗時は定型 FAQ/固定導線へフォールバックする。
 *  5. 会話履歴・入力値は完了後に残さない（PII を持たない設計。clearOnComplete を提供）。
 */
import {
  isChatActionAllowed,
  isActionAllowed,
  CHAT_FORBIDDEN_ACTIONS,
  REQUIRES_CONFIRMATION_ACTIONS,
  type ChatMessage,
  type ReceptionAction,
  type ReceptionState,
} from '@/domain/reception/ui-contract';
import type {
  ChatAdapterResponse,
  ChatLlmAdapter,
  ChatSuggestion,
} from './llm-adapter';

/**
 * タッチ可能なクイックリプライ（チャット返答の下に必ず出す候補）。
 *
 * - kind 'action': そのまま実行してよい許可済みアクション（isChatActionAllowed 済み）。
 * - kind 'confirm-redirect': 重要操作（呼び出し確定・個人情報確定）への誘導。チャットからは
 *   確定できないため、タッチUIの確認画面へ誘導するだけ（needsTouchConfirm = true）。
 * - kind 'staff': 「スタッフに繋ぐ」等の固定導線（フォールバック）。アクションを伴わない。
 */
export type QuickReply =
  | { kind: 'action'; label: string; action: ReceptionAction; optionId?: string }
  | { kind: 'confirm-redirect'; label: string; action: ReceptionAction; needsTouchConfirm: true }
  | { kind: 'staff'; label: string };

/** ドロワーに表示する 1 ターン分の結果（返答本文 + 必ず付くタッチ候補）。 */
export type ChatTurnResult = {
  /** アシスタント返答本文。 */
  reply: string;
  /** タッチ可能な候補。受け入れ条件上、常に 1 件以上を保証する。 */
  quickReplies: QuickReply[];
  /** LLM 失敗/オフライン等で固定導線へフォールバックしたか。 */
  isFallback: boolean;
};

/** 既定のスタッフ誘導（最終フォールバックとして常に出せる固定導線）。 */
export const STAFF_QUICK_REPLY: QuickReply = { kind: 'staff', label: 'スタッフに繋ぐ' };

/**
 * 定型 FAQ（LLM を使わずに答えられる固定導線）。オフライン/失敗時の土台にもなる。
 * PII を含まない一般的な案内のみ。
 */
export type FaqEntry = { id: string; question: string; answer: string };

export const DEFAULT_FAQ: readonly FaqEntry[] = [
  {
    id: 'qr-forgot',
    question: 'QRコードを忘れた',
    answer: 'QRコードが無くても受付できます。画面の案内から担当者をお選びください。',
  },
  {
    id: 'department-only',
    question: '部署名しかわからない',
    answer: '部署からお探しいただけます。画面で部署を選び、担当者を選択してください。',
  },
  {
    id: 'purpose-unknown',
    question: '予約種別がわからない',
    answer: 'ご用件（面接・配送・打ち合わせ等）からお選びいただけます。お困りの場合はスタッフにお繋ぎします。',
  },
];

/** ラベルからのメッセージ ID 生成（衝突回避用の最小実装。PII を含めない）。 */
function nextId(prefix: string, seq: number): string {
  return `${prefix}-${seq}`;
}

/**
 * 初期の呼びかけメッセージ（ドロワーを開いた直後）。控えめな補助導線。
 */
export function buildGreetingMessage(seq = 0, createdAt = new Date(0).toISOString()): ChatMessage {
  return {
    id: nextId('chat-greeting', seq),
    role: 'assistant',
    text: 'お困りですか？ ご用件を入力するか、下のボタンからお選びください。',
    createdAt,
  };
}

/**
 * LLM の 1 候補を、許可検証を通したクイックリプライに変換する。
 *
 * - action を伴わない候補 → そのままラベル候補（staff 扱いにはしない汎用ラベル）。
 *   ただし本関数は action ありの候補のみを対象にし、ラベルだけの候補は呼び出し側で扱う。
 * - 重要操作（CHAT_FORBIDDEN / REQUIRES_CONFIRMATION）→ confirm-redirect に降格。
 * - それ以外で isChatActionAllowed を通る → action として採用。
 * - 通らない（現状態で不許可）→ null（捨てる。チャットは不許可操作を出さない）。
 */
export function suggestionToQuickReply(
  state: ReceptionState,
  suggestion: ChatSuggestion,
): QuickReply | null {
  const { action, label, optionId } = suggestion;
  if (action === undefined) {
    return null;
  }
  // 重要操作はチャットから確定不可。タッチ確認への誘導に降格する。
  // ただし現状態で到達不能な操作（例: idle での confirm）は提示しない（reachability gate）。
  if (CHAT_FORBIDDEN_ACTIONS.has(action) || REQUIRES_CONFIRMATION_ACTIONS.has(action)) {
    if (!isActionAllowed(state, action)) {
      return null;
    }
    return { kind: 'confirm-redirect', label, action, needsTouchConfirm: true };
  }
  if (isChatActionAllowed(state, action)) {
    return { kind: 'action', label, action, optionId };
  }
  return null;
}

/**
 * LLM 応答（または失敗）を 1 ターンの結果に変換する純関数。
 *
 * - suggestions を許可検証して quickReplies を組み立てる。
 * - 受け入れ条件上、quickReplies は必ず 1 件以上にする（最低でもスタッフ誘導を足す）。
 * - response が null（= 失敗/オフライン）なら定型フォールバックへ倒す。
 */
export function buildTurnResult(
  state: ReceptionState,
  response: ChatAdapterResponse | null,
): ChatTurnResult {
  if (response === null) {
    return buildFallbackTurn();
  }
  const quickReplies: QuickReply[] = [];
  for (const s of response.suggestions) {
    const qr = suggestionToQuickReply(state, s);
    if (qr !== null) {
      quickReplies.push(qr);
    }
  }
  // 候補が一つも残らなかった場合でも、必ずタッチ可能な次アクションを保証する。
  if (quickReplies.length === 0) {
    quickReplies.push(STAFF_QUICK_REPLY);
  } else if (!quickReplies.some((q) => q.kind === 'staff')) {
    // スタッフ誘導は常に最後尾の保険として添える。
    quickReplies.push(STAFF_QUICK_REPLY);
  }
  return { reply: response.reply, quickReplies, isFallback: false };
}

/** LLM 失敗/オフライン時の定型ターン（FAQ + スタッフ誘導）。 */
export function buildFallbackTurn(faq: readonly FaqEntry[] = DEFAULT_FAQ): ChatTurnResult {
  const quickReplies: QuickReply[] = faq.map((f) => ({ kind: 'staff', label: f.question }));
  quickReplies.push(STAFF_QUICK_REPLY);
  return {
    reply: 'ただ今うまくお答えできません。よくあるご質問か、スタッフ対応からお選びください。',
    quickReplies,
    isFallback: true,
  };
}

/**
 * 来訪者発話を adapter で解釈し、1 ターンの結果へ変換する（副作用は adapter 呼び出しのみ）。
 *
 * - adapter が例外を投げる/オフラインなら、定型フォールバックへ確実に倒す。
 * - 結果は必ず「候補提示 + タッチ必須」。ここで自由文を直接実行することはない。
 * - PII を保持しない: utterance は adapter へ渡すのみで、本関数は結果に残さない。
 */
export async function runChatTurn(
  adapter: ChatLlmAdapter,
  state: ReceptionState,
  utterance: string,
  opts?: { online?: boolean },
): Promise<ChatTurnResult> {
  const online = opts?.online ?? true;
  if (!online) {
    return buildFallbackTurn();
  }
  try {
    const response = await adapter.interpret({ utterance, screenState: state });
    return buildTurnResult(state, response);
  } catch {
    return buildFallbackTurn();
  }
}

/**
 * 完了/キャンセル後に会話履歴・入力を残さないためのクリア（受け入れ: 履歴を残さない設計）。
 * 純関数として「空配列」を返すだけだが、呼び出し意図を明示するためのヘルパー。
 */
export function clearOnComplete(): ChatMessage[] {
  return [];
}
