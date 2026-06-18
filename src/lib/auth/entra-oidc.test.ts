import { describe, expect, it } from 'vitest';
import { buildAuthorizeUrl, createCodeChallenge, createCodeVerifier, exchangeCodeForToken } from './entra-oidc';

describe('PKCE (#70)', () => {
  it('code_verifier は十分な長さの base64url', () => {
    const v = createCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it('code_challenge は verifier の SHA-256(base64url)', async () => {
    const c = await createCodeChallenge('abc');
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    // 既知の SHA-256('abc') を base64url 化した値
    expect(c).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  });
});

describe('buildAuthorizeUrl (#70)', () => {
  it('authorize エンドポイントと PKCE パラメータを構築する', () => {
    const url = new URL(
      buildAuthorizeUrl({
        issuer: 'https://login.microsoftonline.com/t/v2.0',
        clientId: 'client-1',
        redirectUri: 'https://app/api/admin/auth/entra/callback',
        codeChallenge: 'challenge',
        state: 'state-1',
      }),
    );
    expect(url.pathname).toBe('/t/oauth2/v2.0/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
    expect(url.searchParams.get('state')).toBe('state-1');
  });
});

describe('exchangeCodeForToken (#70)', () => {
  it('token エンドポイントへ PKCE で POST する（Client Secret なし）', async () => {
    let captured: { url: string; body: string } | null = null;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), body: String(init?.body ?? '') };
      return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const res = await exchangeCodeForToken(
      {
        issuer: 'https://login.microsoftonline.com/t/v2.0',
        clientId: 'client-1',
        redirectUri: 'https://app/cb',
        code: 'code-1',
        codeVerifier: 'verifier-1',
      },
      fakeFetch,
    );
    expect(res.access_token).toBe('at');
    expect(captured!.url).toBe('https://login.microsoftonline.com/t/oauth2/v2.0/token');
    expect(captured!.body).toContain('grant_type=authorization_code');
    expect(captured!.body).toContain('code_verifier=verifier-1');
    expect(captured!.body).not.toContain('client_secret');
  });
});
