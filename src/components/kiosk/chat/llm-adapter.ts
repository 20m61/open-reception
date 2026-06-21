/**
 * Chat-assisted ドロワーの LLM 境界 (issue #122 / Epic #119)。
 *
 * 設計方針:
 *  - 実 LLM は呼ばない。差し替え可能な adapter interface + mock を提供する（#104 と整合）。
 *    本番では LLM サービス実装に差し替えるが、その実物検証は #65 にスタックする。
 *  - LLM の「出力」は自由文ではなく、候補（candidates）の構造化提案として受け取る。
 *    LLM が直接アクションを「確定実行」する余地を型レベルで与えない。
 *  - 提案できるアクションはあくまで「候補」。実際に許可されるかは ui-contract の
 *    `isChatActionAllowed` で再検証する（chat-logic.ts）。adapter は信頼境界の外側。
 *  - PII を保持/送信しない。来訪者の自由入力はその場の解釈にのみ使い、履歴へ残さない。
 */
import type { ReceptionAction, ReceptionState } from '@/domain/reception/ui-contract';

/**
 * LLM が提案する 1 候補。`label` はタッチ可能なクイックリプライ/カードの表示文言。
 * `action` を伴う場合、それは「提案」であり確定ではない（タッチ確認に変換される）。
 */
export type ChatSuggestion = {
  /** タッチ表示用の短いラベル（例: 「営業部 山田太郎さん」）。 */
  label: string;
  /** 任意。提案する受付アクション。許可検証は chat-logic 側で行う。 */
  action?: ReceptionAction;
  /**
   * 任意。action に付随する選択値の不透明な識別子（例: staffId / purposeId）。
   * PII を載せない（氏名そのものではなく ID を使う）。
   */
  optionId?: string;
};

/** LLM への問い合わせ入力。PII を含めない最小コンテキスト。 */
export type ChatAdapterRequest = {
  /** 来訪者の自由文入力。adapter 内部での解釈にのみ使い、保持しない。 */
  utterance: string;
  /** 現在の受付状態（許可アクションの文脈に使う）。 */
  screenState: ReceptionState;
};

/** LLM からの構造化応答。自由文の本文 + タッチ可能な候補群。 */
export type ChatAdapterResponse = {
  /** アシスタントの返答本文（短い案内）。 */
  reply: string;
  /** タッチ可能なクイックリプライ/カード候補（0 件でも可）。 */
  suggestions: ChatSuggestion[];
};

/**
 * 差し替え可能な LLM アダプタ境界。
 * 失敗時は例外を投げてよい（呼び出し側 chat-logic がフォールバックへ倒す）。
 */
export interface ChatLlmAdapter {
  /** 来訪者発話を解釈し、構造化応答を返す。 */
  interpret(request: ChatAdapterRequest): Promise<ChatAdapterResponse>;
}

/**
 * テスト/開発用の mock アダプタ。実 LLM を呼ばず、注入された応答を返す。
 *
 * - `scripted`: utterance（正規化後）→ 応答 のマップ。決め打ちのシナリオ検証用。
 * - `fallbackResponse`: マップに無い入力に対する既定応答。
 * - `failOn`: ここに含まれる（正規化後）utterance では例外を投げ、失敗時フォールバックを検証する。
 */
export class MockChatLlmAdapter implements ChatLlmAdapter {
  private readonly scripted: Map<string, ChatAdapterResponse>;
  private readonly fallbackResponse: ChatAdapterResponse;
  private readonly failOn: ReadonlySet<string>;

  constructor(opts?: {
    scripted?: Record<string, ChatAdapterResponse>;
    fallbackResponse?: ChatAdapterResponse;
    failOn?: readonly string[];
  }) {
    const norm = (s: string): string => s.normalize('NFKC').trim().toLowerCase();
    this.scripted = new Map(
      Object.entries(opts?.scripted ?? {}).map(([k, v]) => [norm(k), v] as const),
    );
    this.fallbackResponse = opts?.fallbackResponse ?? {
      reply: 'うまく聞き取れませんでした。下の項目からお選びください。',
      suggestions: [],
    };
    this.failOn = new Set((opts?.failOn ?? []).map(norm));
  }

  async interpret(request: ChatAdapterRequest): Promise<ChatAdapterResponse> {
    const key = request.utterance.normalize('NFKC').trim().toLowerCase();
    if (this.failOn.has(key)) {
      throw new Error('mock LLM failure');
    }
    return this.scripted.get(key) ?? this.fallbackResponse;
  }
}
