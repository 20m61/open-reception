import { describe, it, expect } from 'vitest';
import { createInMemoryReplayGuard } from './replay-guard';

describe('createInMemoryReplayGuard', () => {
  it('allows the first consumption of a jti', () => {
    const guard = createInMemoryReplayGuard(() => 0);
    expect(guard.consume('jti-1', 1000)).toBe(true);
  });

  it('rejects a second consumption of the same jti (replay)', () => {
    const guard = createInMemoryReplayGuard(() => 0);
    expect(guard.consume('jti-1', 1000)).toBe(true);
    expect(guard.consume('jti-1', 1000)).toBe(false);
  });

  it('tracks distinct jti independently', () => {
    const guard = createInMemoryReplayGuard(() => 0);
    expect(guard.consume('jti-1', 1000)).toBe(true);
    expect(guard.consume('jti-2', 1000)).toBe(true);
  });

  it('sweeps expired entries so memory does not grow unbounded across many short-lived tokens', () => {
    let now = 0;
    const guard = createInMemoryReplayGuard(() => now);
    for (let i = 0; i < 500; i += 1) {
      guard.consume(`jti-${i}`, now + 100); // 各 token は 100ms で失効
      now += 10;
    }
    // 十分に時間が経過した後は、古い jti は掃除されて再消費できる余地が無いことより先に、
    // 内部状態が増え続けないことを size で検証する。
    now += 100_000;
    expect(guard.size()).toBeLessThan(50);
  });

  it('does not resurrect a swept (expired) jti as fresh for a still-valid claim window — expiry is enforced by the caller, this guard only tracks replay', () => {
    // このガードは「消費済みか」だけを見る。期限切れ token 自体の拒否は token.ts の role/exp が担う。
    // ここでは掃除後に同じ jti を新しい有効期限で再度 consume した場合、ガードとしては許可する
    // （token レイヤの exp チェックを二重にここへ持ち込まない設計）ことを明示しておく。
    let now = 0;
    const guard = createInMemoryReplayGuard(() => now);
    expect(guard.consume('jti-1', 50)).toBe(true);
    now = 1000; // jti-1 の期限(50)をとうに過ぎた
    expect(guard.consume('jti-1', 2000)).toBe(true);
  });
});
