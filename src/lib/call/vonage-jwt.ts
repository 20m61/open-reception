/**
 * Vonage Video API（Unified）向けの RS256 JWT 生成 (issue #4, docs/vonage-call-design.md §10)。
 *
 * 外部依存なし（node:crypto のみ）。すべて server-only。
 *   - アプリ認証 JWT: REST 呼び出しの Authorization: Bearer に使う。
 *   - client 接続トークン: クライアントへ渡す唯一の値。scope=session.connect。
 *
 * private key（PEM）はサーバ内に留め、クライアントへは短命トークンのみ渡す。
 */
import { createSign, randomUUID } from 'node:crypto';

export type TokenRole = 'publisher' | 'subscriber' | 'moderator';

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** RS256 で JWT を生成する（汎用）。privateKey は PEM 文字列。 */
export function signRs256(payload: Record<string, unknown>, privateKeyPem: string): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).end().sign(privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

export type VonageJwtParams = {
  applicationId: string;
  privateKeyPem: string;
  /** epoch 秒（テスト用に注入可能）。既定は現在時刻。 */
  nowSec?: number;
  /** 有効期限（秒）。 */
  ttlSec?: number;
};

const DEFAULT_APP_TTL_SEC = 120;
const DEFAULT_TOKEN_TTL_SEC = 300;

/**
 * Vonage REST 呼び出し用のアプリ認証 JWT。
 * claims: application_id / iat / exp / jti。
 */
export function generateAppJwt(params: VonageJwtParams): string {
  const iat = params.nowSec ?? Math.floor(Date.now() / 1000);
  const exp = iat + (params.ttlSec ?? DEFAULT_APP_TTL_SEC);
  return signRs256(
    { application_id: params.applicationId, iat, exp, jti: randomUUID() },
    params.privateKeyPem,
  );
}

export type ClientTokenParams = VonageJwtParams & {
  sessionId: string;
  role: TokenRole;
};

export type ClientToken = {
  token: string;
  role: TokenRole;
  /** ISO8601。短命。 */
  expiresAt: string;
};

/**
 * クライアントへ渡す接続トークン（session.connect）。
 * claims: application_id / scope / session_id / role / iat / exp / jti。
 */
export function generateClientToken(params: ClientTokenParams): ClientToken {
  const iat = params.nowSec ?? Math.floor(Date.now() / 1000);
  const exp = iat + (params.ttlSec ?? DEFAULT_TOKEN_TTL_SEC);
  const token = signRs256(
    {
      application_id: params.applicationId,
      scope: 'session.connect',
      session_id: params.sessionId,
      role: params.role,
      iat,
      exp,
      jti: randomUUID(),
    },
    params.privateKeyPem,
  );
  return { token, role: params.role, expiresAt: new Date(exp * 1000).toISOString() };
}

/** テスト/検証用: JWT の payload 部をデコードする（署名検証はしない）。 */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1];
  if (!part) throw new Error('invalid jwt');
  const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return JSON.parse(json) as Record<string, unknown>;
}
