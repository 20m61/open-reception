/**
 * Entra OIDC callback の堅牢化テスト (issue #70)。
 * state 照合（PKCE）・IdP エラー・トークン交換失敗時に、機密を漏らさず
 * /admin/login?error= へ安全に誘導することを検証する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ENTRA_STATE_COOKIE, ENTRA_TOKEN_COOKIE, ENTRA_VERIFIER_COOKIE } from '@/lib/auth/admin';

const exchangeCodeForToken = vi.fn();
const verifyEntraToken = vi.fn();

vi.mock('@/lib/auth/entra-oidc', () => ({
  exchangeCodeForToken: (...a: unknown[]) => exchangeCodeForToken(...a),
}));
vi.mock('@/lib/auth/entra', () => ({
  createJwksResolver: () => async () => null,
  verifyEntraToken: (...a: unknown[]) => verifyEntraToken(...a),
}));

import { GET } from './route';

const ENV_KEYS = ['ADMIN_AUTH_PROVIDER', 'ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_AUDIENCE'];
const saved: Record<string, string | undefined> = {};

function makeReq(search: string, cookies: Record<string, string>): NextRequest {
  const url = `http://localhost/api/admin/auth/entra/callback${search}`;
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  return new NextRequest(url, { headers: cookieHeader ? { cookie: cookieHeader } : {} });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ADMIN_AUTH_PROVIDER = 'entra';
  process.env.ENTRA_TENANT_ID = 't';
  process.env.ENTRA_CLIENT_ID = 'client-1';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function locationOf(res: Response): string {
  return res.headers.get('location') ?? '';
}

describe('GET /api/admin/auth/entra/callback (#70)', () => {
  it('IdP の error を尊重して login へ誘導（トークン交換しない）', async () => {
    const res = await GET(makeReq('?error=access_denied', {}));
    expect(res.status).toBe(307);
    expect(locationOf(res)).toContain('/admin/login?error=access_denied');
    expect(exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it('state 不一致は invalid_state（トークン交換しない）', async () => {
    const res = await GET(
      makeReq('?code=c&state=attacker', {
        [ENTRA_STATE_COOKIE]: 'real-state',
        [ENTRA_VERIFIER_COOKIE]: 'verifier',
      }),
    );
    expect(locationOf(res)).toContain('error=invalid_state');
    expect(exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it('verifier cookie 欠落は invalid_state', async () => {
    const res = await GET(makeReq('?code=c&state=s', { [ENTRA_STATE_COOKIE]: 's' }));
    expect(locationOf(res)).toContain('error=invalid_state');
    expect(exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it('state 一致で PKCE トークン交換へ進む。失敗時は token_exchange_failed', async () => {
    exchangeCodeForToken.mockResolvedValue({ error: 'invalid_grant' });
    const res = await GET(
      makeReq('?code=c&state=s', {
        [ENTRA_STATE_COOKIE]: 's',
        [ENTRA_VERIFIER_COOKIE]: 'verifier',
      }),
    );
    expect(exchangeCodeForToken).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'c', codeVerifier: 'verifier' }),
    );
    expect(locationOf(res)).toContain('error=token_exchange_failed');
  });

  it('トークン検証失敗は unauthorized（cookie を発行しない）', async () => {
    exchangeCodeForToken.mockResolvedValue({ access_token: 'at', expires_in: 3600 });
    verifyEntraToken.mockResolvedValue({ ok: false, reason: 'role_not_allowed' });
    const res = await GET(
      makeReq('?code=c&state=s', {
        [ENTRA_STATE_COOKIE]: 's',
        [ENTRA_VERIFIER_COOKIE]: 'verifier',
      }),
    );
    expect(locationOf(res)).toContain('error=unauthorized');
    expect(res.headers.getSetCookie?.().join(';') ?? '').not.toContain(ENTRA_TOKEN_COOKIE);
  });

  it('検証成功で /admin へ。トークンは cookie のみ（本文へ出さない）', async () => {
    exchangeCodeForToken.mockResolvedValue({ access_token: 'secret-access-token', expires_in: 3600 });
    verifyEntraToken.mockResolvedValue({ ok: true, role: 'Admin', subject: 'oid-1' });
    const res = await GET(
      makeReq('?code=c&state=s', {
        [ENTRA_STATE_COOKIE]: 's',
        [ENTRA_VERIFIER_COOKIE]: 'verifier',
      }),
    );
    expect(locationOf(res)).toContain('/admin');
    const setCookies = res.headers.getSetCookie?.().join(';') ?? '';
    expect(setCookies).toContain(`${ENTRA_TOKEN_COOKIE}=secret-access-token`);
    const body = await res.text();
    expect(body).not.toContain('secret-access-token');
  });
});
