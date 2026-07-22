import { describe, expect, it } from 'vitest';
import {
  DEMO_SHARE_RATE_LIMIT,
  createShareAccessLimiter,
  tryShareAccess,
} from './share-access';

const NOW = 1_000_000;

describe('share-access 固定窓レート制限（公開経路の乱用抑止）', () => {
  it('窓内は上限まで許可し、超過を拒否する', () => {
    let limiter = createShareAccessLimiter();
    for (let i = 0; i < DEMO_SHARE_RATE_LIMIT.maxPerWindow; i++) {
      const r = tryShareAccess(limiter, 'tok-a', NOW);
      expect(r.allowed).toBe(true);
      limiter = r.limiter;
    }
    const over = tryShareAccess(limiter, 'tok-a', NOW);
    expect(over.allowed).toBe(false);
  });

  it('窓が明けるとカウンタがリセットされる', () => {
    let limiter = createShareAccessLimiter();
    for (let i = 0; i < DEMO_SHARE_RATE_LIMIT.maxPerWindow; i++) {
      limiter = tryShareAccess(limiter, 'tok-a', NOW).limiter;
    }
    expect(tryShareAccess(limiter, 'tok-a', NOW).allowed).toBe(false);
    const later = NOW + DEMO_SHARE_RATE_LIMIT.windowMs;
    const r = tryShareAccess(limiter, 'tok-a', later);
    expect(r.allowed).toBe(true);
  });

  it('トークンごとに独立に数える', () => {
    let limiter = createShareAccessLimiter();
    for (let i = 0; i < DEMO_SHARE_RATE_LIMIT.maxPerWindow; i++) {
      limiter = tryShareAccess(limiter, 'tok-a', NOW).limiter;
    }
    expect(tryShareAccess(limiter, 'tok-a', NOW).allowed).toBe(false);
    // 別トークンは影響を受けない。
    expect(tryShareAccess(limiter, 'tok-b', NOW).allowed).toBe(true);
  });
});
