import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_API_CONNECTION_HEADER,
  adminApiContextOptions,
  formatKioskSessionTransportError,
  isSocketResetError,
} from './kiosk-session-transport';

const HELPERS = readFileSync('tests/e2e/helpers.ts', 'utf8');
const TESTING_RULE = readFileSync('.claude/rules/testing.md', 'utf8');

describe('kiosk session transport (#847)', () => {
  it('admin APIRequestContext は keep-alive 再利用を Connection: close で止める', () => {
    expect(adminApiContextOptions('http://127.0.0.1:3000')).toEqual({
      baseURL: 'http://127.0.0.1:3000',
      extraHTTPHeaders: { Connection: ADMIN_API_CONNECTION_HEADER },
    });
    expect(ADMIN_API_CONNECTION_HEADER).toBe('close');
  });

  it('Playwright が包んだ ECONNRESET もソケットリセットと判定する', () => {
    const wrapped = new Error('apiRequestContext.post: read ECONNRESET');
    expect(isSocketResetError(wrapped)).toBe(true);
    const coded = Object.assign(new Error('read'), { code: 'ECONNRESET' });
    expect(isSocketResetError(coded)).toBe(true);
    expect(isSocketResetError(new Error('connect ECONNREFUSED 127.0.0.1:3000'))).toBe(false);
    expect(isSocketResetError(new Error('Timeout 30000ms exceeded'))).toBe(false);
  });

  it('cause に載った ECONNRESET も拾う', () => {
    const inner = Object.assign(new Error('read'), { code: 'ECONNRESET' });
    expect(isSocketResetError(new Error('fetch failed', { cause: inner }))).toBe(true);
  });

  it('RST は fixture 輸送と分かる文言に包み、それ以外はそのまま返す', () => {
    const reset = formatKioskSessionTransportError(
      new Error('apiRequestContext.post: read ECONNRESET'),
      'POST /api/admin/login',
    );
    expect(reset.message).toContain('kiosk-session-transport');
    expect(reset.message).toContain('POST /api/admin/login');
    expect(reset.message).toContain('#847');
    expect(reset.message).toContain('keep-alive');
    expect(reset.message).not.toMatch(/リトライ|retry/i);

    const other = new Error('Timeout 30000ms exceeded');
    expect(formatKioskSessionTransportError(other, 'POST /api/admin/login')).toBe(other);
  });

  it('establishKioskSession はオプションと包みを使い、ECONNRESET をリトライしない', () => {
    const body = HELPERS.slice(HELPERS.indexOf('export async function establishKioskSession'));
    expect(body).toMatch(/adminApiContextOptions\(/);
    expect(body).toMatch(/formatKioskSessionTransportError\(/);
    // 実装本体にリトライを足さない（JSDoc が「retry で緑になる」と説明するのは可）。
    expect(body).not.toMatch(/\b(retry|retries|再試行)\b/i);
  });

  it('testing.md は ECONNRESET を「既知だから無視」と書かない', () => {
    expect(TESTING_RULE).toContain('#847');
    expect(TESTING_RULE).toMatch(/Connection:\s*close/);
    expect(TESTING_RULE).not.toMatch(/負荷時の\s*`ECONNRESET`\s*散発は既知/);
  });
});
