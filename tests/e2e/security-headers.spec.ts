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
});

test('kiosk と admin もセキュリティヘッダを返す', async ({ request }) => {
  for (const path of ['/kiosk', '/admin/login']) {
    const res = await request.get(path);
    expect(res.headers()['content-security-policy']).toBeTruthy();
    expect(res.headers()['x-frame-options']).toBe('DENY');
  }
});
