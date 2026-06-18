/**
 * Entra ID OIDC ログイン導線（Authorization Code + PKCE） (issue #70)。
 * パブリッククライアント構成（Client Secret 不要）を前提とし、secret をフロントに置かない。
 *
 * 実テナントに対する対話ログインは実環境前提のため、対話フローの e2e は #70/#65 にスタックし、
 * ここでは URL 構築・PKCE・トークン交換のロジックを純関数化して単体検証する。
 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** ランダムな code_verifier（43〜128 文字の base64url）。 */
export function createCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** code_challenge = base64url(SHA256(code_verifier))。 */
export async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

export type AuthorizeParams = {
  issuer: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  /** 既定: openid profile email + audience の access。 */
  scope?: string;
};

/** Entra の authorize エンドポイント URL を構築する（secret 不要）。 */
export function buildAuthorizeUrl(params: AuthorizeParams): string {
  const base = params.issuer.replace(/\/v2\.0\/?$/, '').replace(/\/+$/, '');
  const url = new URL(`${base}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', params.scope ?? 'openid profile email');
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export type TokenExchangeInput = {
  issuer: string;
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
};

export type TokenResponse = { access_token?: string; id_token?: string; expires_in?: number; error?: string };

/** authorization code を PKCE でトークンへ交換する（Client Secret 不要）。 */
export async function exchangeCodeForToken(
  input: TokenExchangeInput,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const base = input.issuer.replace(/\/v2\.0\/?$/, '').replace(/\/+$/, '');
  const body = new URLSearchParams({
    client_id: input.clientId,
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  const res = await fetchImpl(`${base}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    cache: 'no-store',
  });
  return (await res.json().catch(() => ({ error: 'bad_token_response' }))) as TokenResponse;
}
