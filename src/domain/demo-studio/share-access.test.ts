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

describe('share-access 敵対的レビュー W1 対応（トークン回転・Map 増大）', () => {
  it('トークンを毎回変えても全体窓の上限で頭打ちになる', () => {
    let limiter = createShareAccessLimiter();
    let allowedCount = 0;
    for (let i = 0; i < DEMO_SHARE_RATE_LIMIT.maxTotalPerWindow + 50; i++) {
      const r = tryShareAccess(limiter, `rotating-token-${i}`, 1_000);
      limiter = r.limiter;
      if (r.allowed) allowedCount++;
    }
    expect(allowedCount).toBe(DEMO_SHARE_RATE_LIMIT.maxTotalPerWindow);
  });

  it('トークン別バケットは保持上限を超えない（無限増大防止）', () => {
    let limiter = createShareAccessLimiter();
    for (let i = 0; i < DEMO_SHARE_RATE_LIMIT.maxTrackedTokens + 100; i++) {
      limiter = tryShareAccess(limiter, `evict-token-${i}`, 1_000 + i).limiter;
    }
    expect(limiter.buckets.size).toBeLessThanOrEqual(DEMO_SHARE_RATE_LIMIT.maxTrackedTokens);
  });

  it('全体窓も窓明けでリセットされる', () => {
    let limiter = createShareAccessLimiter();
    for (let i = 0; i < DEMO_SHARE_RATE_LIMIT.maxTotalPerWindow; i++) {
      limiter = tryShareAccess(limiter, `t-${i}`, 1_000).limiter;
    }
    expect(tryShareAccess(limiter, 'next', 1_000).allowed).toBe(false);
    expect(tryShareAccess(limiter, 'next', 1_000 + DEMO_SHARE_RATE_LIMIT.windowMs).allowed).toBe(true);
  });
});
