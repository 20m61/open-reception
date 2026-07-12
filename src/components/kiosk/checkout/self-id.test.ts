import { describe, expect, it } from 'vitest';
import {
  CHECKOUT_CODE_LENGTH,
  CHECKOUT_TOKEN_QUERY,
  extractCheckoutToken,
  isCredentialExpired,
  normalizeCheckoutCode,
  normalizeTargetLabel,
  targetLabelMatches,
} from './self-id';

/**
 * 退館の自己特定 純ロジック (issue #328)。
 *
 * 副作用なし。コード/ラベルの正規化・照合、TTL 判定、QR/URL からの token 抽出を検証する。
 * PII を扱わない（コードは低エントロピー数字、token は高エントロピー乱数、ラベルは部署名等の非 PII）。
 */

describe('normalizeCheckoutCode (#328)', () => {
  it('4 桁の数字はそのまま返す', () => {
    expect(normalizeCheckoutCode('0426')).toBe('0426');
    expect(normalizeCheckoutCode('9999')).toBe('9999');
  });

  it('前後・内部の空白を除去して 4 桁なら受理する', () => {
    expect(normalizeCheckoutCode('  0426 ')).toBe('0426');
    expect(normalizeCheckoutCode('04 26')).toBe('0426');
  });

  it('全角数字を半角へ正規化して受理する', () => {
    expect(normalizeCheckoutCode('０４２６')).toBe('0426');
  });

  it('桁数不足・超過・非数字・空は null', () => {
    expect(normalizeCheckoutCode('426')).toBeNull();
    expect(normalizeCheckoutCode('04266')).toBeNull();
    expect(normalizeCheckoutCode('04a6')).toBeNull();
    expect(normalizeCheckoutCode('')).toBeNull();
    expect(normalizeCheckoutCode('   ')).toBeNull();
    expect(normalizeCheckoutCode(null)).toBeNull();
    expect(normalizeCheckoutCode(42)).toBeNull();
  });

  it('コード長は定数と一致する', () => {
    expect(CHECKOUT_CODE_LENGTH).toBe(4);
  });
});

describe('normalizeTargetLabel / targetLabelMatches (#328)', () => {
  it('前後空白・大小文字・内部空白の差を無視して一致する', () => {
    expect(targetLabelMatches('  Sales Dept ', 'sales   dept')).toBe(true);
    expect(targetLabelMatches('総務部', ' 総務部 ')).toBe(true);
  });

  it('異なるラベルは一致しない', () => {
    expect(targetLabelMatches('総務部', '営業部')).toBe(false);
  });

  it('空ラベル同士は一致とみなさない（照合を素通りさせない）', () => {
    expect(targetLabelMatches('', '')).toBe(false);
    expect(targetLabelMatches('   ', '総務部')).toBe(false);
    expect(normalizeTargetLabel('  a  b ')).toBe('a b');
  });
});

describe('isCredentialExpired (#328)', () => {
  const base = '2026-07-12T09:00:00.000Z';
  it('expiresAt 到達前は未失効', () => {
    expect(isCredentialExpired(base, new Date('2026-07-12T08:59:59.000Z'))).toBe(false);
  });
  it('expiresAt 到達（同時刻含む）で失効', () => {
    expect(isCredentialExpired(base, new Date(base))).toBe(true);
    expect(isCredentialExpired(base, new Date('2026-07-12T09:00:01.000Z'))).toBe(true);
  });
  it('不正な expiresAt は安全側（失効扱い）', () => {
    expect(isCredentialExpired('not-a-date', new Date(base))).toBe(true);
  });
});

describe('extractCheckoutToken (#328)', () => {
  const token = 'abcDEF-_123456ghiJKL';
  it('checkout URL の ?ct= から token を取り出す', () => {
    expect(extractCheckoutToken(`https://example.com/kiosk/checkout?${CHECKOUT_TOKEN_QUERY}=${token}`)).toBe(
      token,
    );
  });
  it('生の base64url token を受理する', () => {
    expect(extractCheckoutToken(token)).toBe(token);
  });
  it('URL だが ct が無い・別クエリは null', () => {
    expect(extractCheckoutToken('https://example.com/kiosk/checkout?rt=' + token)).toBeNull();
  });
  it('記号混入・空・非文字列は null', () => {
    expect(extractCheckoutToken('has space')).toBeNull();
    expect(extractCheckoutToken('a/b?c')).toBeNull();
    expect(extractCheckoutToken('')).toBeNull();
    expect(extractCheckoutToken(null)).toBeNull();
  });
});
