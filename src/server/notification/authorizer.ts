/**
 * 拠点認可 Lambda authorizer (DESIGN #34 §7)。
 *
 * 拠点ごとに識別子（siteId）と短命トークンを発行し、API Gateway の
 * Lambda authorizer（HTTP API / SIMPLE レスポンス）で検証する。
 * 管理 API と通知実行 API を分離し、最小権限・スコープ分離を保つ。
 *
 * トークン検証鍵は Secrets Manager / 環境変数で server-only に保持する。
 * 本実装は HMAC 署名トークン（`<siteId>.<exp>.<sigHex>`）を検証する純ロジックを
 * 切り出し、単体テスト可能にする。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerWithContextResult,
} from 'aws-lambda';

export interface AuthContext {
  siteId: string;
}

export interface VerifyResult {
  authorized: boolean;
  siteId?: string;
  reason?: string;
}

/** `<siteId>.<expEpochSec>.<hmacHex>` 形式の拠点トークンを検証する。 */
export function verifySiteToken(
  token: string | undefined,
  secret: string,
  nowSec: number,
): VerifyResult {
  if (!token) return { authorized: false, reason: 'missing_token' };
  const parts = token.split('.');
  if (parts.length !== 3) return { authorized: false, reason: 'malformed_token' };
  const [siteId, expRaw, sigHex] = parts;
  if (!siteId || !expRaw || !sigHex) return { authorized: false, reason: 'malformed_token' };

  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp <= 0) return { authorized: false, reason: 'malformed_exp' };
  if (exp < nowSec) return { authorized: false, reason: 'expired' };

  const expected = createHmac('sha256', secret).update(`${siteId}.${expRaw}`).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(sigHex, 'hex');
  } catch {
    return { authorized: false, reason: 'bad_signature_encoding' };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { authorized: false, reason: 'bad_signature' };
  }
  return { authorized: true, siteId };
}

/** Authorization ヘッダ（`Bearer <token>` または raw）からトークンを取り出す。 */
export function extractToken(headers: Record<string, string | undefined> | undefined): string | undefined {
  const raw = headers?.authorization ?? headers?.Authorization;
  if (!raw) return undefined;
  return raw.startsWith('Bearer ') ? raw.slice('Bearer '.length).trim() : raw.trim();
}

/**
 * 拠点トークン検証鍵を解決する。
 * - `SITE_TOKEN_SECRET`（env 直接）を最優先。
 * - 無ければ `SITE_TOKEN_SECRET_ARN` から Secrets Manager で取得し、warm container 内でキャッシュ。
 * いずれも無ければ undefined（呼び出し側で fail-closed）。
 */
let cachedSecret: string | undefined;
async function resolveSiteTokenSecret(
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  if (env.SITE_TOKEN_SECRET) return env.SITE_TOKEN_SECRET;
  if (cachedSecret) return cachedSecret;
  const arn = env.SITE_TOKEN_SECRET_ARN;
  if (!arn) return undefined;
  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    '@aws-sdk/client-secrets-manager'
  );
  const client = new SecretsManagerClient({ region: env.AWS_REGION ?? 'ap-northeast-1' });
  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  cachedSecret = res.SecretString ?? undefined;
  return cachedSecret;
}

/** HTTP API SIMPLE 形式の Lambda authorizer エントリ。 */
export async function handler(
  event: APIGatewayRequestAuthorizerEventV2,
): Promise<APIGatewaySimpleAuthorizerWithContextResult<AuthContext | Record<string, never>>> {
  const secret = await resolveSiteTokenSecret();
  if (!secret) {
    // fail closed: 鍵が無い構成では一切認可しない。
    return { isAuthorized: false, context: {} };
  }
  const token = extractToken(event.headers as Record<string, string | undefined> | undefined);
  const nowSec = Math.floor(Date.now() / 1000);
  const result = verifySiteToken(token, secret, nowSec);
  if (!result.authorized || !result.siteId) {
    return { isAuthorized: false, context: {} };
  }
  return { isAuthorized: true, context: { siteId: result.siteId } };
}
