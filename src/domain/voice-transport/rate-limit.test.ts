import { describe, it, expect } from 'vitest';
import { createRateLimiterState, tryConsume, type VoiceTransportRateLimiterConfig } from './rate-limit';

const config: VoiceTransportRateLimiterConfig = { capacity: 5, refillPerMs: 1 / 100 }; // 1 token / 100ms

describe('token bucket rate limiter', () => {
  it('starts full at capacity', () => {
    const state = createRateLimiterState(config, 0);
    expect(state.tokens).toBe(5);
  });

  it('allows consuming up to capacity in a burst with no elapsed time', () => {
    let state = createRateLimiterState(config, 0);
    for (let i = 0; i < 5; i += 1) {
      const r = tryConsume(state, config, 1, 0);
      expect(r.allowed).toBe(true);
      state = r.state;
    }
    // バケットが尽きた — 追加の即時送信は拒否される（送信レート制限）。
    const r = tryConsume(state, config, 1, 0);
    expect(r.allowed).toBe(false);
  });

  it('refills over elapsed time up to the cap', () => {
    let state = createRateLimiterState(config, 0);
    state = tryConsume(state, config, 5, 0).state; // drain to 0
    expect(tryConsume(state, config, 1, 50).allowed).toBe(false); // 50ms → 0.5 tokens, not enough
    const after100 = tryConsume(state, config, 1, 100); // 100ms → 1 token
    expect(after100.allowed).toBe(true);
  });

  it('never refills beyond capacity even after a very long idle period', () => {
    let state = createRateLimiterState(config, 0);
    state = tryConsume(state, config, 2, 0).state; // tokens = 3
    const farFuture = tryConsume(state, config, 0, 1_000_000_000); // huge elapsed, cost 0 just to observe refill
    expect(farFuture.state.tokens).toBe(config.capacity);
  });

  it('rejecting a request does not silently consume tokens', () => {
    let state = createRateLimiterState(config, 0);
    state = tryConsume(state, config, 5, 0).state; // drain
    const rejected = tryConsume(state, config, 1, 0);
    expect(rejected.allowed).toBe(false);
    expect(rejected.state.tokens).toBe(0);
  });

  it('is monotonic: lastRefillMs never moves backward across calls with increasing nowMs', () => {
    let state = createRateLimiterState(config, 0);
    state = tryConsume(state, config, 1, 10).state;
    state = tryConsume(state, config, 1, 20).state;
    expect(state.lastRefillMs).toBe(20);
  });
});
