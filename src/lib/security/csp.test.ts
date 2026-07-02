import { describe, expect, it } from 'vitest';
import { buildCsp, createCspNonce } from './csp';

describe('createCspNonce', () => {
  it('呼び出しごとに異なる値を返す（per-request nonce）', () => {
    const seen = new Set(Array.from({ length: 20 }, () => createCspNonce()));
    expect(seen.size).toBe(20);
  });

  it('CSP ヘッダに安全に埋め込める base64 文字列を返す（十分なエントロピー長）', () => {
    const nonce = createCspNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+=*$/);
    // 128bit 以上のエントロピー（base64 で 22 文字以上）を要求する。
    expect(nonce.length).toBeGreaterThanOrEqual(22);
  });
});

describe('buildCsp', () => {
  const nonce = 'dGVzdC1ub25jZQ==';

  it('script-src を nonce 化し unsafe-inline を含めない (#200)', () => {
    const csp = buildCsp(nonce);
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src'))!;
    expect(scriptSrc).toContain(`'nonce-${nonce}'`);
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    // 段階導入: strict-dynamic は付けない（'self' で同一オリジン chunk を許可）。
    expect(scriptSrc).not.toContain("'strict-dynamic'");
  });

  it('style-src は現状維持（unsafe-inline のまま。別課題）', () => {
    const styleSrc = buildCsp(nonce)
      .split(';')
      .find((d) => d.trim().startsWith('style-src'))!;
    expect(styleSrc).toContain("'unsafe-inline'");
  });

  it('既存の堅牢化ディレクティブを維持する（#6/#31 と同等）', () => {
    const csp = buildCsp(nonce);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("connect-src 'self' blob:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    // スキームワイルドカードを持たない（ZAP 10055）。
    expect(csp).not.toContain(' https:');
  });

  it('開発時のみ unsafe-eval を許可する（React のデバッグ用 eval）', () => {
    expect(buildCsp(nonce, { dev: true })).toContain("'unsafe-eval'");
    expect(buildCsp(nonce)).not.toContain("'unsafe-eval'");
    expect(buildCsp(nonce, { dev: false })).not.toContain("'unsafe-eval'");
  });
});
