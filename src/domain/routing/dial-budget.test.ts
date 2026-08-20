import { describe, expect, it } from 'vitest';
import { DIAL_BUDGET_MARGIN_SECONDS, dialExpiresAtFrom } from './dial-budget';

describe('dialExpiresAtFrom (#647)', () => {
  it('呼出タイムアウトに余裕を足した期限を返す', () => {
    expect(dialExpiresAtFrom(new Date('2026-08-20T00:00:00.000Z'), 20)).toBe(
      '2026-08-20T00:00:50.000Z',
    );
  });

  it('🔴 余裕は正 ── 0 以下だと鳴っている最中に打ち切る', () => {
    expect(DIAL_BUDGET_MARGIN_SECONDS).toBeGreaterThan(0);
  });
});
