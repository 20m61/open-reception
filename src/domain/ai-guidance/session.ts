/**
 * AI 案内セッションのドメインモデル (issue #104 increment 1)。
 *
 * 安全方針:
 *  - 自由会話・回答テキスト・PII を **保持しない**。判断に必要な最小の計量値のみを持つ。
 *  - エスカレーション判定は純関数。AI 出力（信頼度・NG ワード一致）を入力に取るが、
 *    その結果は「引き継ぎ要求」イベントを返すだけで、AI が操作を即時実行することはない。
 *  - 実際の状態遷移は state.ts の状態機械を通す。
 *
 * 本モジュールは純関数のみ（副作用なし）。LLM を呼ばない。
 */
import {
  type AiGuidanceEvent,
  type AiGuidanceState,
  type EscalationReason,
  escalationReasonFor,
  transition,
} from './state';

/**
 * エスカレーション判定の閾値。テナント別に上書きする前提の既定値。
 */
export type EscalationPolicy = {
  /** これ未満の確信度（0..1）で低信頼とみなす。 */
  minConfidence: number;
  /** 連続失敗がこの回数に達したらエスカレーション。 */
  maxRepeatedFailures: number;
  /** 無応答がこのミリ秒を超えたらタイムアウトでエスカレーション。 */
  idleTimeoutMs: number;
};

export const DEFAULT_ESCALATION_POLICY: EscalationPolicy = {
  minConfidence: 0.5,
  maxRepeatedFailures: 2,
  idleTimeoutMs: 30_000,
};

/**
 * AI 案内セッション。PII・会話内容は含めない。
 *  - repeatedFailures: 連続で解決できなかった回数（質問テキストは保持しない）。
 *  - lastInteractionAt: 最後にやり取りした時刻（タイムアウト判定用）。
 */
export type AiGuidanceSession = {
  id: string;
  kioskId: string;
  state: AiGuidanceState;
  policy: EscalationPolicy;
  repeatedFailures: number;
  /** エスカレーションした理由（監査・分析用、会話内容は含めない）。 */
  escalationReason?: EscalationReason;
  lastInteractionAt: string;
  startedAt: string;
  updatedAt: string;
};

/** 新規セッションを `guiding` 状態で生成する。 */
export function createAiGuidanceSession(params: {
  id: string;
  kioskId: string;
  now: string;
  policy?: EscalationPolicy;
}): AiGuidanceSession {
  return {
    id: params.id,
    kioskId: params.kioskId,
    state: 'guiding',
    policy: params.policy ?? DEFAULT_ESCALATION_POLICY,
    repeatedFailures: 0,
    lastInteractionAt: params.now,
    startedAt: params.now,
    updatedAt: params.now,
  };
}

/**
 * 1 回の AI 案内応答の観測値（会話内容は持たない）。
 * これを評価してエスカレーションが必要かを判定する。
 */
export type GuidanceTurnSignal = {
  /** AI 応答の確信度（0..1）。 */
  confidence: number;
  /** その応答で来訪者の用件を解決できたか。false が続くと連続失敗としてカウント。 */
  resolved: boolean;
  /** NG ワード（要注意・禁止語）を検知したか。検知語そのものは渡さない（真偽のみ）。 */
  ngWordDetected: boolean;
  /** 来訪者が明示的に有人対応を要求したか。 */
  userRequestedHuman: boolean;
};

/**
 * エスカレーション判定結果。`event` が null ならエスカレーション不要。
 * 優先順位: ユーザー要求 > NG ワード > 低信頼 > 連続失敗。
 * （安全側: 来訪者の明示要求と要注意語を最優先で人間へ）
 */
export type EscalationDecision = {
  event: Extract<
    AiGuidanceEvent,
    'REQUEST_HUMAN' | 'NG_WORD' | 'LOW_CONFIDENCE' | 'REPEATED_FAILURE' | 'TIMEOUT'
  > | null;
  reason: EscalationReason | null;
};

const NO_ESCALATION: EscalationDecision = { event: null, reason: null };

/**
 * シグナルからエスカレーションすべきかを判定する純関数。
 * resolved=false が続くと連続失敗カウントを進めるが、その更新は applyTurn 側で行う。
 * ここでは「次に進めるべきイベント」を決めるだけ（状態は変更しない）。
 */
export function evaluateEscalation(
  session: AiGuidanceSession,
  signal: GuidanceTurnSignal,
): EscalationDecision {
  if (signal.userRequestedHuman) {
    return { event: 'REQUEST_HUMAN', reason: 'user_request' };
  }
  if (signal.ngWordDetected) {
    return { event: 'NG_WORD', reason: 'ng_word' };
  }
  if (signal.confidence < session.policy.minConfidence) {
    return { event: 'LOW_CONFIDENCE', reason: 'low_confidence' };
  }
  // 今回 unresolved を加味した連続失敗回数で判定する。
  const nextFailures = signal.resolved ? 0 : session.repeatedFailures + 1;
  if (nextFailures >= session.policy.maxRepeatedFailures) {
    return { event: 'REPEATED_FAILURE', reason: 'repeated_failure' };
  }
  return NO_ESCALATION;
}

/** 最後のやり取りからの経過時間でタイムアウト判定する純関数。 */
export function isIdleTimeout(session: AiGuidanceSession, now: string): boolean {
  const elapsed = new Date(now).getTime() - new Date(session.lastInteractionAt).getTime();
  return elapsed >= session.policy.idleTimeoutMs;
}

/**
 * 1 ターンのシグナルを適用してセッションを更新する純関数。
 * - エスカレーションが必要なら状態機械を通して `handoff_requested` へ進める。
 *   AI が操作を即時実行することはない（必ず引き継ぎ要求を経由）。
 * - 不要なら `guiding` のまま、連続失敗カウントと最終やり取り時刻を更新する。
 */
export function applyTurn(
  session: AiGuidanceSession,
  signal: GuidanceTurnSignal,
  now: string,
): AiGuidanceSession {
  // guiding 以外でターンを適用しない（引き継ぎ要求後は人間の管轄）。
  if (session.state !== 'guiding') {
    return session;
  }
  const decision = evaluateEscalation(session, signal);
  const nextFailures = signal.resolved ? 0 : session.repeatedFailures + 1;

  if (decision.event === null) {
    return {
      ...session,
      repeatedFailures: nextFailures,
      lastInteractionAt: now,
      updatedAt: now,
    };
  }

  const nextState = transition(session.state, decision.event);
  // 状態機械上、guiding からエスカレーションイベントは必ず handoff_requested へ遷移する。
  if (nextState === null) {
    return session;
  }
  return {
    ...session,
    state: nextState,
    repeatedFailures: nextFailures,
    escalationReason: decision.reason ?? undefined,
    lastInteractionAt: now,
    updatedAt: now,
  };
}

/**
 * 状態機械イベントを適用してセッションを進める純関数（引き継ぎ確定/失敗/フォールバック等）。
 * エスカレーションイベントを直接渡された場合も理由を記録する。
 */
export function dispatch(
  session: AiGuidanceSession,
  event: AiGuidanceEvent,
  now: string,
): AiGuidanceSession {
  const nextState = transition(session.state, event);
  if (nextState === null) {
    return session;
  }
  const reason = escalationReasonFor(event);
  return {
    ...session,
    state: nextState,
    escalationReason: reason ?? session.escalationReason,
    updatedAt: now,
  };
}
