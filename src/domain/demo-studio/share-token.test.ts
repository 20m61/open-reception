import { describe, expect, it } from 'vitest';
import {
  DEMO_SHARE_DEFAULT_TTL_MS,
  DEMO_SHARE_MAX_TTL_MS,
  generateShareTokenValue,
  isShareTokenActive,
  issueShareToken,
  isValidShareTokenValue,
  revokeShareToken,
} from './share-token';

const NOW = Date.UTC(2026, 6, 22, 0, 0, 0);

describe('generateShareTokenValue', () => {
  it('base64url・十分な長さ（32 バイト = 43 文字）で PII を含まない', () => {
    const t = generateShareTokenValue();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(43);
  });
  it('毎回異なる（衝突しない）', () => {
    const set = new Set(Array.from({ length: 200 }, () => generateShareTokenValue()));
    expect(set.size).toBe(200);
  });
  it('isValidShareTokenValue は形式のみ受理する', () => {
    expect(isValidShareTokenValue(generateShareTokenValue())).toBe(true);
    expect(isValidShareTokenValue('has space')).toBe(false);
    expect(isValidShareTokenValue('short')).toBe(false);
    expect(isValidShareTokenValue('with/slash+plus============================')).toBe(false);
    expect(isValidShareTokenValue('')).toBe(false);
  });
});

describe('issueShareToken', () => {
  it('既定 TTL で発行し expiresAt を設定する（有効期限は必須）', () => {
    const s = issueShareToken(NOW);
    expect(isValidShareTokenValue(s.token)).toBe(true);
    expect(new Date(s.issuedAt).getTime()).toBe(NOW);
    expect(new Date(s.expiresAt).getTime()).toBe(NOW + DEMO_SHARE_DEFAULT_TTL_MS);
    expect(s.revokedAt).toBeUndefined();
  });
  it('TTL は上限にクランプされる（乱用抑止：無期限を許さない）', () => {
    const s = issueShareToken(NOW, DEMO_SHARE_MAX_TTL_MS * 10);
    expect(new Date(s.expiresAt).getTime()).toBe(NOW + DEMO_SHARE_MAX_TTL_MS);
  });
  it('非正の TTL は既定 TTL にフォールバックする', () => {
    const s = issueShareToken(NOW, 0);
    expect(new Date(s.expiresAt).getTime()).toBe(NOW + DEMO_SHARE_DEFAULT_TTL_MS);
  });
});

describe('isShareTokenActive', () => {
  it('発行直後は有効', () => {
    const s = issueShareToken(NOW);
    expect(isShareTokenActive(s, NOW)).toBe(true);
  });
  it('有効期限切れは無効', () => {
    const s = issueShareToken(NOW, 1000);
    expect(isShareTokenActive(s, NOW + 999)).toBe(true);
    expect(isShareTokenActive(s, NOW + 1000)).toBe(false);
    expect(isShareTokenActive(s, NOW + 5000)).toBe(false);
  });
  it('失効後は期限内でも無効', () => {
    const s = revokeShareToken(issueShareToken(NOW), NOW + 100);
    expect(isShareTokenActive(s, NOW + 200)).toBe(false);
  });
});

describe('revokeShareToken', () => {
  it('revokedAt を刻む（token 値は変えない＝再解決を無効化するだけ）', () => {
    const s = issueShareToken(NOW);
    const r = revokeShareToken(s, NOW + 50);
    expect(r.token).toBe(s.token);
    expect(new Date(r.revokedAt!).getTime()).toBe(NOW + 50);
  });
  it('二重失効は最初の失効時刻を保持する（冪等）', () => {
    const s = revokeShareToken(issueShareToken(NOW), NOW + 50);
    const again = revokeShareToken(s, NOW + 999);
    expect(new Date(again.revokedAt!).getTime()).toBe(NOW + 50);
  });
});
