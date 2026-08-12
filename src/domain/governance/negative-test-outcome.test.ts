import { describe, expect, it } from 'vitest';
import { classifyAwsError, summarizeNegativeTests } from './negative-test-outcome';

/**
 * `scripts/aws-negative-tests.ts` の判定部分（純関数）。
 *
 * 🔴 このスクリプト全体は AWS 認証情報が無いと動かず、本サイクルでは一度も実走しない。
 * 実走しないコードをテスト無しで置かないため、判定ロジックをここへ切り出して固定する。
 */

describe('classifyAwsError', () => {
  it.each(['AccessDenied', 'accessdenied', 'An error occurred (AccessDenied)'])(
    'AccessDenied を含む stderr は denied: %s',
    (stderr) => {
      expect(classifyAwsError(stderr)).toBe('denied');
    },
  );

  it.each(['not authorized', 'NOT AUTHORIZED to perform', 'User is not Authorized'])(
    'not authorized を含む stderr は denied（大小無視）: %s',
    (stderr) => {
      expect(classifyAwsError(stderr)).toBe('denied');
    },
  );

  it.each(['explicit deny', 'with an explicit deny in an identity-based policy'])(
    'explicit deny を含む stderr は denied（大小無視）: %s',
    (stderr) => {
      expect(classifyAwsError(stderr)).toBe('denied');
    },
  );

  it('空文字は unknown（[[空文字は「問題なし」ではない]] の型）', () => {
    expect(classifyAwsError('')).toBe('unknown');
  });

  it('拒否シグナルを含まない stderr は unknown（判定不能を勝手に denied にしない）', () => {
    expect(classifyAwsError('Could not connect to the endpoint URL')).toBe('unknown');
  });

  it('ThrottlingException のような無関係なエラーも unknown', () => {
    expect(classifyAwsError('An error occurred (ThrottlingException)')).toBe('unknown');
  });
});

describe('summarizeNegativeTests', () => {
  it('全件一致なら failed=0', () => {
    const result = summarizeNegativeTests([
      { id: 'N1', expected: 'denied', actual: 'denied' },
      { id: 'N2', expected: 'allowed', actual: 'allowed' },
    ]);
    expect(result).toEqual({ failed: 0 });
  });

  it('期待と異なれば failed をカウントする', () => {
    const result = summarizeNegativeTests([
      { id: 'N1', expected: 'denied', actual: 'allowed' },
      { id: 'N2', expected: 'allowed', actual: 'allowed' },
    ]);
    expect(result).toEqual({ failed: 1 });
  });

  it('unknown は expected が denied でも PASS にしない（判定不能を PASS にしない）', () => {
    const result = summarizeNegativeTests([{ id: 'N1', expected: 'denied', actual: 'unknown' }]);
    expect(result).toEqual({ failed: 1 });
  });

  it('unknown は expected が allowed でも PASS にしない', () => {
    const result = summarizeNegativeTests([{ id: 'N4', expected: 'allowed', actual: 'unknown' }]);
    expect(result).toEqual({ failed: 1 });
  });

  it('複数件の failed を正しく合算する', () => {
    const result = summarizeNegativeTests([
      { id: 'N1', expected: 'denied', actual: 'unknown' },
      { id: 'N2', expected: 'denied', actual: 'allowed' },
      { id: 'N3', expected: 'allowed', actual: 'allowed' },
      { id: 'N4', expected: 'denied', actual: 'denied' },
    ]);
    expect(result).toEqual({ failed: 2 });
  });

  it('空配列は failed=0', () => {
    expect(summarizeNegativeTests([])).toEqual({ failed: 0 });
  });
});
