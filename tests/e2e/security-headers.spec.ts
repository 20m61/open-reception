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

test('script-src は nonce 化され unsafe-inline を含まない (#200)', async ({ request }) => {
  const res = await request.get('/');
  const csp = res.headers()['content-security-policy'];
  const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src'));
  expect(scriptSrc).toBeTruthy();
  expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/]+=*'/);
  expect(scriptSrc).not.toContain("'unsafe-inline'");
});

test('style-src は unsafe-inline を含まず、style 属性は style-src-attr で許可する (#289)', async ({ request }) => {
  const res = await request.get('/');
  const directives = res
    .headers()
    ['content-security-policy'].split(';')
    .map((d) => d.trim());
  const styleSrc = directives.find((d) => d.startsWith('style-src '));
  const styleSrcAttr = directives.find((d) => d.startsWith('style-src-attr'));
  // 本番ビルド（e2e 対象）では style-src（elem フォールバック）は 'self' のみ。
  expect(styleSrc).toBe("style-src 'self'");
  // React SSR の style 属性は style-src-attr で明示許可する（nonce 不可のため）。
  expect(styleSrcAttr).toBe("style-src-attr 'unsafe-inline'");
});

test('inline <style> なしでスタイルが適用される（CSP violation なし / #289）', async ({ page }) => {
  // 注: /kiosk は #239 のセッションゲートで enroll なしだと受付画面にならないため、
  // 素の fixture で検証できるランディングを対象にする（kiosk 画面の CSP 影響は
  // kiosk-* suite の表示/スクリーンショット検証が担保する）。
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (msg.text().includes('Content Security Policy')) violations.push(msg.text());
  });
  await page.goto('/');
  await expect(page.getByTestId('lp-login')).toBeVisible();
  // 外部 stylesheet（globals.css）が実際に適用されている（ブロックされていない）こと。
  const bodyMargin = await page.evaluate(() => getComputedStyle(document.body).margin);
  expect(bodyMargin).toBe('0px');
  expect(violations).toEqual([]);
});

test('nonce はレスポンスごとに変わる (#200)', async ({ request }) => {
  const nonceOf = (csp: string) => csp.match(/'nonce-([^']+)'/)?.[1];
  const [a, b] = await Promise.all([request.get('/'), request.get('/')]);
  const nonceA = nonceOf(a.headers()['content-security-policy']);
  const nonceB = nonceOf(b.headers()['content-security-policy']);
  expect(nonceA).toBeTruthy();
  expect(nonceA).not.toBe(nonceB);
});

test('未認証の /admin リダイレクト(307)も Content-Type を返す', async ({ request }) => {
  // ZAP 10019: Content-Type 欠落の解消。リダイレクト本体は追わずに 307 応答そのものを検査する。
  const res = await request.get('/admin', { maxRedirects: 0 });
  expect(res.status()).toBe(307);
  expect(res.headers()['content-type']).toContain('text/plain');
});

test('kiosk と admin もセキュリティヘッダを返す', async ({ request }) => {
  for (const path of ['/kiosk', '/admin/login']) {
    const res = await request.get(path);
    expect(res.headers()['content-security-policy']).toBeTruthy();
    expect(res.headers()['x-frame-options']).toBe('DENY');
  }
});
