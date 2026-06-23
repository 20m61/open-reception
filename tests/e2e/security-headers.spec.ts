import { test, expect } from '@playwright/test';

/**
 * セキュリティヘッダの E2E (issue #6)。
 * 主要レスポンスに CSP・クリックジャッキング対策・nosniff 等が付与されることを確認する。
 */
test('トップのレスポンスにセキュリティヘッダが付与される', async ({ request }) => {
  const res = await request.get('/');
  const headers = res.headers();
  expect(headers['content-security-policy']).toContain("default-src 'self'");
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(headers['permissions-policy']).toContain('geolocation=()');
  // CSP はスキームワイルドカードを持たない（ZAP 10055）。
  expect(headers['content-security-policy']).not.toContain(' https:');
  // クロスオリジン分離ヘッダ（ZAP 90004 / 堅牢化）。
  expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(headers['cross-origin-resource-policy']).toBe('same-origin');
});

test('kiosk と admin もセキュリティヘッダを返す', async ({ request }) => {
  for (const path of ['/kiosk', '/admin/login']) {
    const res = await request.get(path);
    expect(res.headers()['content-security-policy']).toBeTruthy();
    expect(res.headers()['x-frame-options']).toBe('DENY');
  }
});
