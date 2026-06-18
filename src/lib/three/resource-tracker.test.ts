import { describe, expect, it, vi } from 'vitest';
import { ResourceTracker } from './resource-tracker';

describe('ResourceTracker (#36)', () => {
  it('登録したリソースを一括 dispose し空になる', () => {
    const tracker = new ResourceTracker();
    const a = { dispose: vi.fn() };
    const b = { dispose: vi.fn() };
    tracker.track(a);
    tracker.track(b);
    expect(tracker.size).toBe(2);

    tracker.disposeAll();
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).toHaveBeenCalledTimes(1);
    expect(tracker.size).toBe(0);
  });

  it('dispose が例外でも残りを破棄し続ける（受付画面を壊さない）', () => {
    const tracker = new ResourceTracker();
    const bad = { dispose: () => { throw new Error('boom'); } };
    const good = { dispose: vi.fn() };
    tracker.track(bad);
    tracker.track(good);
    expect(() => tracker.disposeAll()).not.toThrow();
    expect(good.dispose).toHaveBeenCalledTimes(1);
  });

  it('track は同じ参照を返す', () => {
    const tracker = new ResourceTracker();
    const r = { dispose: vi.fn() };
    expect(tracker.track(r)).toBe(r);
  });
});
