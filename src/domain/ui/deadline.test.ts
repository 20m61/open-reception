import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startDeadline } from './deadline';

describe('startDeadline (#1029)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('締切前は切れていない', () => {
    const d = startDeadline(1_000);
    vi.advanceTimersByTime(999);
    expect(d.expired()).toBe(false);
    expect(d.signal.aborted).toBe(false);
    d.done();
  });

  it('締切を過ぎたら切れ、signal も abort される', () => {
    const d = startDeadline(1_000);
    vi.advanceTimersByTime(1_000);
    expect(d.expired()).toBe(true);
    expect(d.signal.aborted).toBe(true);
  });

  /*
    🔴 **往復が終わったら解放する。** 解放しないと、成功した往復のぶんだけタイマーが
    残り、後から `abort()` が走る。同じ signal を使い回す経路があると、
    **成功した直後の操作が「締切切れ」と誤判定される**。
  */
  it('done() を呼べば、その後に締切時刻が来ても切れない', () => {
    const d = startDeadline(1_000);
    d.done();
    vi.advanceTimersByTime(5_000);
    expect(d.expired()).toBe(false);
    expect(d.signal.aborted).toBe(false);
  });

  /*
    🔴 **`AbortSignal.timeout` を使っていないこと**（3 周目 BLOCKER-1）。
    あれは Safari 16 からで、iPadOS 15 以前では**呼んだ瞬間に投げて要求が 1 本も飛ばない**。
    実装がそちらへ戻る変異を、この 1 本が落とす。
  */
  it('AbortSignal.timeout に依存しない（古い iPadOS Safari で要求が飛ばなくなる）', () => {
    const original = AbortSignal.timeout;
    // @ts-expect-error 非対応環境を再現する
    delete AbortSignal.timeout;
    try {
      const d = startDeadline(1_000);
      expect(d.expired()).toBe(false);
      d.done();
    } finally {
      AbortSignal.timeout = original;
    }
  });
});
