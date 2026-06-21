/**
 * AI 案内オーケストレーションの interface (issue #104 increment 1)。
 *
 * 安全方針:
 *  - LLM 実呼び出しは差し替え可能な adapter（GuidanceProvider）の背後に隔離する。
 *  - increment 1 では実 LLM を呼ばない（mock のみ）。実連携は将来の increment。
 *  - provider へ渡す入力は最小化し、PII を送らない（PromptContext は識別子・カテゴリのみ）。
 *  - provider の出力（回答テキスト）はそのまま操作に使わず、確信度/NG 判定だけを
 *    エスカレーション判定に使い、最終実行は必ず有人/担当者を経由する。
 */
import type { EscalationReason } from '@/domain/ai-guidance/state';

/**
 * LLM へ渡してよい最小コンテキスト。会話の生テキスト・PII は含めない。
 *  - utterance: 来訪者の発話（補助案内の入力）。provider 実装側で送信前に最小化/マスクする。
 *  - locale: 言語（多言語案内のため）。
 *  - allowedTopics: 回答してよいトピック（FAQ/施設案内/受付操作など）の許可リスト。
 */
export type GuidanceRequest = {
  sessionId: string;
  locale: string;
  utterance: string;
  allowedTopics: ReadonlyArray<string>;
};

/**
 * provider の応答。回答テキストに加え、エスカレーション判定に必要な計量値を返す。
 *  - confidence: 確信度 0..1。
 *  - ngWordDetected: 禁止/要注意語の検知（検知語そのものは返さない）。
 *  - outOfScope: 許可トピック外の質問か（誤案内防止）。
 */
export type GuidanceResponse = {
  answer: string;
  confidence: number;
  ngWordDetected: boolean;
  outOfScope: boolean;
};

/**
 * 差し替え可能な LLM provider。実 LLM 連携時はこの interface を実装する。
 * increment 1 では MockGuidanceProvider のみ。
 */
export interface GuidanceProvider {
  readonly id: string;
  generate(request: GuidanceRequest): Promise<GuidanceResponse>;
}

/**
 * 引き継ぎ先（既存導線）への取り次ぎ adapter の interface。
 * 実装は既存の受付フロー/担当者通知/Vonage/代表窓口へ接続する（本 increment では mock）。
 * AI が直接呼ぶのではなく、状態機械が handoff_requested に入った後に呼ばれる。
 */
export interface HandoffChannel {
  readonly id: string;
  /** 担当者/有人へ引き継ぎ要求を出す。成立すれば true。 */
  requestHandoff(input: HandoffRequest): Promise<HandoffOutcome>;
}

export type HandoffRequest = {
  sessionId: string;
  kioskId: string;
  reason: EscalationReason;
};

export type HandoffOutcome = {
  /** 担当者/有人へ確実に引き継げたか。 */
  accepted: boolean;
  /** 失敗時のフォールバック先（既存受付フロー等）。accepted=false のときに使う。 */
  fallbackHint?: 'reception_flow' | 'reception_phone' | 'department';
};
