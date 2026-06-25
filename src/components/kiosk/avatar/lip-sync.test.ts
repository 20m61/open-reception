import { describe, it, expect } from 'vitest';
import { MOUTH_OPEN_MAX, mouthOpenValue } from './lip-sync';

describe('lip-sync (#5/#31)', () => {
  it('発話していなければ常に口を閉じる（0）', () => {
    for (let t = 0; t < 10; t += 0.13) {
      expect(mouthOpenValue(t, false)).toBe(0);
    }
  });

  it('発話中は 0..MOUTH_OPEN_MAX に収まる', () => {
    const samples = Array.from({ length: 200 }, (_, i) => mouthOpenValue(i * 0.05, true));
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...samples)).toBeLessThanOrEqual(MOUTH_OPEN_MAX + 1e-9);
  });

  it('発話中は口が開く瞬間（>0）と閉じる瞬間（0）の両方がある', () => {
    const samples = Array.from({ length: 200 }, (_, i) => mouthOpenValue(i * 0.05, true));
    expect(samples.some((v) => v > 0.2)).toBe(true);
    expect(samples.some((v) => v === 0)).toBe(true);
  });
});
