/**
 * 送信レート制限のトークンバケット純ロジック (issue #369「送信レートを制限する」)。
 *
 * 時刻は呼び出し側が渡す（`nowMs`）。テストで決定的に検証できるよう `Date.now()` を
 * 内部で呼ばない純関数にする。
 */

export type VoiceTransportRateLimiterState = {
  tokens: number;
  lastRefillMs: number;
};

export type VoiceTransportRateLimiterConfig = {
  /** バケット容量（バースト許容量）。 */
  capacity: number;
  /** 1ms あたりの補充量。 */
  refillPerMs: number;
};

export function createRateLimiterState(config: VoiceTransportRateLimiterConfig, nowMs: number): VoiceTransportRateLimiterState {
  return { tokens: config.capacity, lastRefillMs: nowMs };
}

export type VoiceTransportRateLimitResult = {
  allowed: boolean;
  state: VoiceTransportRateLimiterState;
};

/**
 * `cost` 分のトークンを消費できるか判定する。許可されればトークンを消費した新状態を、
 * 拒否されれば（補充のみ反映した）新状態を返す。
 */
export function tryConsume(
  state: VoiceTransportRateLimiterState,
  config: VoiceTransportRateLimiterConfig,
  cost: number,
  nowMs: number,
): VoiceTransportRateLimitResult {
  const elapsed = Math.max(0, nowMs - state.lastRefillMs);
  const refilled = Math.min(config.capacity, state.tokens + elapsed * config.refillPerMs);

  if (refilled >= cost) {
    return { allowed: true, state: { tokens: refilled - cost, lastRefillMs: nowMs } };
  }
  return { allowed: false, state: { tokens: refilled, lastRefillMs: nowMs } };
}
