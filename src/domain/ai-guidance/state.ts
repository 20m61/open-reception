/**
 * AI 案内 → 担当者/有人対応への安全切替の状態機械 (issue #104 increment 1)。
 *
 * 設計方針（docs/ai-guidance-handoff-design.md と一致させる）:
 *  - AI 案内は補助導線。最終判断・実行は必ず有人/担当者を経由する。
 *  - AI は受付操作（呼び出し・通話発信など）を即時に実行しない。エスカレーション時は
 *    必ず「担当者へ引き継ぐ要求」を経由し、人間/既存受付フローへ戻す。
 *  - 自由会話・回答内容・PII は本モデルに持ち込まない。状態とイベントのみを扱う。
 *
 * 本モジュールは純関数のみ（副作用なし）。LLM を呼ばない。
 */

export const AI_GUIDANCE_STATES = [
  /** AI が補助案内中（FAQ・受付操作案内など）。 */
  'guiding',
  /** 引き継ぎが要求され、担当者/有人窓口の応答待ち（確認・取り次ぎ中）。 */
  'handoff_requested',
  /** 担当者/有人窓口へ確実に引き継がれた（終端）。 */
  'handed_off',
  /** 引き継ぎに失敗した（取り次ぎ不能等）。代替導線へフォールバックさせる前段（終端）。 */
  'failed',
] as const;

export type AiGuidanceState = (typeof AI_GUIDANCE_STATES)[number];

/**
 * 状態を進めるイベント。エスカレーション系イベントは「即時実行」ではなく
 * 「引き継ぎ要求」に倒す。AI 自身が CONNECT/CALL するイベントは存在しない。
 */
export const AI_GUIDANCE_EVENTS = [
  /** 来訪者が明示的に担当者/有人を要求した。 */
  'REQUEST_HUMAN',
  /** AI の確信度が閾値未満（低信頼）。 */
  'LOW_CONFIDENCE',
  /** 応答タイムアウト（無操作・無応答が続いた）。 */
  'TIMEOUT',
  /** 禁止/要注意ワード（NG ワード）を検知した。 */
  'NG_WORD',
  /** 連続失敗が上限に達した（同じ質問を解決できない）。 */
  'REPEATED_FAILURE',
  /** 引き継ぎ要求に対し担当者/有人が応答し、確実に引き継がれた。 */
  'HANDOFF_CONFIRMED',
  /** 引き継ぎ要求が成立しなかった（取り次ぎ不能・無応答）。 */
  'HANDOFF_FAILED',
  /** 引き継ぎ失敗後、来訪者を既存受付フロー/代替導線へ戻す（フォールバック）。 */
  'FALLBACK',
  /** 端末リセット（次の来訪者へ。どの状態からでも guiding へ戻す）。 */
  'RESET',
] as const;

export type AiGuidanceEvent = (typeof AI_GUIDANCE_EVENTS)[number];

/**
 * エスカレーション条件。`guiding` から `handoff_requested` へ遷移させる
 * トリガーの種別を表す（監査・分析用に区別する。会話内容は含めない）。
 */
export const ESCALATION_REASONS = [
  'user_request',
  'low_confidence',
  'timeout',
  'ng_word',
  'repeated_failure',
] as const;

export type EscalationReason = (typeof ESCALATION_REASONS)[number];

/** エスカレーションを引き起こすイベント → 理由の写像。 */
const ESCALATION_EVENT_TO_REASON: Partial<Record<AiGuidanceEvent, EscalationReason>> = {
  REQUEST_HUMAN: 'user_request',
  LOW_CONFIDENCE: 'low_confidence',
  TIMEOUT: 'timeout',
  NG_WORD: 'ng_word',
  REPEATED_FAILURE: 'repeated_failure',
};

/**
 * 状態遷移表。`[state][event]` 未定義なら不正遷移。
 * 重要: エスカレーション系イベントはすべて `handoff_requested`（= 引き継ぎ要求）に倒す。
 * AI が直接 `handed_off`（実行完了）へ飛ぶ遷移は存在しない（即時実行禁止の保証）。
 */
const TRANSITIONS: Partial<Record<AiGuidanceState, Partial<Record<AiGuidanceEvent, AiGuidanceState>>>> = {
  guiding: {
    REQUEST_HUMAN: 'handoff_requested',
    LOW_CONFIDENCE: 'handoff_requested',
    TIMEOUT: 'handoff_requested',
    NG_WORD: 'handoff_requested',
    REPEATED_FAILURE: 'handoff_requested',
  },
  handoff_requested: {
    HANDOFF_CONFIRMED: 'handed_off',
    HANDOFF_FAILED: 'failed',
  },
  failed: {
    FALLBACK: 'handed_off',
  },
  handed_off: {},
};

/** 終端状態（ここからは RESET 以外の前進がない）。 */
export const TERMINAL_STATES: ReadonlySet<AiGuidanceState> = new Set<AiGuidanceState>([
  'handed_off',
]);

export function isAiGuidanceState(value: unknown): value is AiGuidanceState {
  return typeof value === 'string' && (AI_GUIDANCE_STATES as readonly string[]).includes(value);
}

export function isEscalationEvent(event: AiGuidanceEvent): boolean {
  return event in ESCALATION_EVENT_TO_REASON;
}

/** エスカレーションイベントから理由を返す。エスカレーション以外なら null。 */
export function escalationReasonFor(event: AiGuidanceEvent): EscalationReason | null {
  return ESCALATION_EVENT_TO_REASON[event] ?? null;
}

/**
 * 与えられた状態とイベントの遷移先を返す。不正遷移なら null。
 * RESET は安全のため全状態から guiding を許可する（端末の自動リセット）。
 */
export function transition(state: AiGuidanceState, event: AiGuidanceEvent): AiGuidanceState | null {
  if (event === 'RESET') {
    return 'guiding';
  }
  return TRANSITIONS[state]?.[event] ?? null;
}

/** 不正遷移時に例外を投げる版。 */
export function transitionOrThrow(state: AiGuidanceState, event: AiGuidanceEvent): AiGuidanceState {
  const next = transition(state, event);
  if (next === null) {
    throw new Error(`Invalid ai-guidance transition: ${state} -(${event})-> ?`);
  }
  return next;
}

export function isTerminal(state: AiGuidanceState): boolean {
  return TERMINAL_STATES.has(state);
}
