import { describe, expect, it } from 'vitest';
import { CHECKOUT_FAILURE_MESSAGE } from './logic';

describe('CHECKOUT_FAILURE_MESSAGE (issue #102)', () => {
  it('失敗理由ごとに来訪者向け文言を返す（PII を含まない）', () => {
    expect(CHECKOUT_FAILURE_MESSAGE('not_found')).toContain('見つかりません');
    expect(CHECKOUT_FAILURE_MESSAGE('already_checked_out')).toContain('退館済み');
    expect(CHECKOUT_FAILURE_MESSAGE('invalid')).toContain('受付番号');
    expect(CHECKOUT_FAILURE_MESSAGE('network')).toContain('通信エラー');
    expect(CHECKOUT_FAILURE_MESSAGE(undefined)).toContain('通信エラー');
  });
});
