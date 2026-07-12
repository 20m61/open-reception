import { describe, expect, it } from 'vitest';
import { makeT } from '@/lib/i18n';
import { CHECKOUT_FAILURE_MESSAGE } from './logic';

describe('CHECKOUT_FAILURE_MESSAGE (issue #102 / #327 i18n)', () => {
  it('失敗理由ごとに来訪者向け文言を返す（PII を含まない, ja）', () => {
    const tr = makeT('ja');
    expect(CHECKOUT_FAILURE_MESSAGE('not_found', tr)).toContain('見つかりません');
    expect(CHECKOUT_FAILURE_MESSAGE('already_checked_out', tr)).toContain('退館済み');
    expect(CHECKOUT_FAILURE_MESSAGE('invalid', tr)).toContain('受付番号');
    expect(CHECKOUT_FAILURE_MESSAGE('network', tr)).toContain('通信エラー');
    expect(CHECKOUT_FAILURE_MESSAGE(undefined, tr)).toContain('通信エラー');
  });

  it('en locale では日本語が一切露出しない', () => {
    const tr = makeT('en');
    expect(CHECKOUT_FAILURE_MESSAGE('not_found', tr)).toBe(
      'We could not find that reception number. Please check the number and try again.',
    );
    expect(CHECKOUT_FAILURE_MESSAGE('already_checked_out', tr)).toBe(
      'This reception number has already been checked out.',
    );
    expect(CHECKOUT_FAILURE_MESSAGE('invalid', tr)).toBe('Please enter a reception number.');
    expect(CHECKOUT_FAILURE_MESSAGE('network', tr)).toBe('A network error occurred. Please try again.');
    expect(CHECKOUT_FAILURE_MESSAGE(undefined, tr)).toBe('A network error occurred. Please try again.');
  });

  it('ko / zh locale でも対応する文言を解決する', () => {
    expect(CHECKOUT_FAILURE_MESSAGE('not_found', makeT('ko'))).toContain('접수 번호');
    expect(CHECKOUT_FAILURE_MESSAGE('not_found', makeT('zh'))).toContain('受理编号');
  });

  it('自己特定（#328/#339）由来の失敗理由も文言化する（expired/throttled/not_recognized）', () => {
    const tr = makeT('ja');
    expect(CHECKOUT_FAILURE_MESSAGE('expired', tr)).toContain('有効期限');
    expect(CHECKOUT_FAILURE_MESSAGE('throttled', tr)).toContain('制限');
    expect(CHECKOUT_FAILURE_MESSAGE('not_recognized', tr)).toContain('確認できませんでした');
    // en でも日本語が露出しない。
    const en = makeT('en');
    expect(CHECKOUT_FAILURE_MESSAGE('expired', en)).toBe(
      'This checkout code has expired. Please ask reception for help.',
    );
    expect(CHECKOUT_FAILURE_MESSAGE('throttled', en)).toBe(
      'Too many checkout code attempts. Please wait a moment, use your checkout QR, or ask reception for help.',
    );
    expect(CHECKOUT_FAILURE_MESSAGE('not_recognized', en)).toBe(
      'We could not recognize that checkout code or visit target. Please check and try again.',
    );
  });
});
