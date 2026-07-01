import { describe, expect, it } from 'vitest';
import { formatPercent } from './format';

describe('formatPercent', () => {
  it('割合を小数第1位のパーセントにする', () => {
    expect(formatPercent(0.5)).toBe('50%');
    expect(formatPercent(0.333)).toBe('33.3%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0)).toBe('0%');
  });
  it('null は「—」', () => {
    expect(formatPercent(null)).toBe('—');
  });
});
