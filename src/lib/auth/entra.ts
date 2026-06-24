/**
 * Microsoft Entra ID（OIDC）アクセストークン検証 (issue #70)。
 * Edge middleware / Node Route の双方で動くよう Web Crypto のみを使い、RS256 を検証する。
 *
 * 検証項目: 署名（JWKS の公開鍵）・issuer・audience・exp/nbf・roles claim。
 * secret/private key は扱わない（公開鍵のみ）。クライアントへは何も渡さない。
 */
import { resolveAdminRole, type AdminRole } from '@/domain/auth/roles';

const decoder = new TextDecoder();

export type EntraClaims = {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  sub?: string;
  oid?: string;
  preferred_username?: string;
  email?: string;
  roles?: unknown;
  [key: string]: unknown;
};

export type VerifyResult =
  | { ok: true; role: AdminRole; subject: string; email?: string; claims: EntraClaims }
  | { ok: false; reason: string };

/** JWKS の鍵（DOM の JsonWebKey は kid を含まないため拡張する）。 */
export type Jwk = JsonWebKey & { kid?: string };
export type JwkResolver = (kid: string) => Promise<Jwk | null>;

export type VerifyOptions = {
  issuer: string;
  audience: string;
  allowedRoles: Set<AdminRole>;
  getKey: JwkResolver;
  /** 時刻ずれ許容（秒）。既定 60。 */
  clockToleranceSec?: number;
  /** テスト用に現在時刻（ms）を注入する。 */
  now?: number;
};

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson<T>(segment: string): T | null {
  try {
    return JSON.parse(decoder.decode(fromBase64Url(segment))) as T;
  } catch {
    return null;
  }
}

function audienceMatches(aud: string | string[] | undefined, expected: string): boolean {
  if (aud === undefined) return false;
  return Array.isArray(aud) ? aud.includes(expected) : aud === expected;
}

/**
 * Entra アクセストークン（JWT）を検証して管理ロールを返す。
 * 失敗理由は呼び出し側のログ用（クライアントには汎用 401/403 のみ返す）。
 */
export async function verifyEntraToken(token: string, options: VerifyOptions): Promise<VerifyResult> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed_token' };
  const [headerSeg, payloadSeg, sigSeg] = parts;
  if (!headerSeg || !payloadSeg || !sigSeg) return { ok: false, reason: 'malformed_token' };

  const header = decodeJson<{ alg?: string; kid?: string; typ?: string }>(headerSeg);
  if (!header) return { ok: false, reason: 'bad_header' };
  if (header.alg !== 'RS256') return { ok: false, reason: 'unsupported_alg' };
  if (!header.kid) return { ok: false, reason: 'missing_kid' };

  const jwk = await options.getKey(header.kid).catch(() => null);
  if (!jwk) return { ok: false, reason: 'unknown_kid' };

  let valid: boolean;
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const data = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`);
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromBase64Url(sigSeg), data);
  } catch {
    return { ok: false, reason: 'verify_error' };
  }
  if (!valid) return { ok: false, reason: 'bad_signature' };

  const claims = decodeJson<EntraClaims>(payloadSeg);
  if (!claims) return { ok: false, reason: 'bad_payload' };

  if (claims.iss !== options.issuer) return { ok: false, reason: 'issuer_mismatch' };
  if (!audienceMatches(claims.aud, options.audience)) return { ok: false, reason: 'audience_mismatch' };

  const nowSec = Math.floor((options.now ?? Date.now()) / 1000);
  const leeway = options.clockToleranceSec ?? 60;
  if (typeof claims.exp === 'number' && claims.exp + leeway < nowSec) return { ok: false, reason: 'expired' };
  if (typeof claims.nbf === 'number' && claims.nbf - leeway > nowSec) return { ok: false, reason: 'not_yet_valid' };

  const role = resolveAdminRole(claims.roles);
  if (!role) return { ok: false, reason: 'no_admin_role' };
  if (!options.allowedRoles.has(role)) return { ok: false, reason: 'role_not_allowed' };

  const subject = claims.oid ?? claims.sub ?? '';
  if (!subject) return { ok: false, reason: 'missing_subject' };

  return {
    ok: true,
    role,
    subject,
    email: claims.preferred_username ?? claims.email,
    claims,
  };
}

/* ---------- JWKS 取得（キャッシュ付き） ---------- */

type JwksCache = { uri: string; keys: Map<string, Jwk>; fetchedAt: number };
let jwksCache: JwksCache | null = null;
const JWKS_TTL_MS = 10 * 60 * 1000;

/**
 * JWKS URI から kid→JWK を解決する resolver を作る。10 分キャッシュ。
 * 未知の kid のときは一度だけ再取得して鍵ローテーションに追従する。
 */
export function createJwksResolver(jwksUri: string, fetchImpl: typeof fetch = fetch): JwkResolver {
  async function refresh(): Promise<void> {
    const res = await fetchImpl(jwksUri, { cache: 'no-store' });
    if (!res.ok) throw new Error(`jwks_fetch_failed_${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    const keys = new Map<string, Jwk>();
    for (const k of body.keys ?? []) {
      if (k.kid) keys.set(k.kid, k);
    }
    jwksCache = { uri: jwksUri, keys, fetchedAt: Date.now() };
  }

  return async (kid: string): Promise<Jwk | null> => {
    const fresh = jwksCache && jwksCache.uri === jwksUri && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
    if (!fresh) await refresh();
    let jwk = jwksCache?.keys.get(kid) ?? null;
    if (!jwk && jwksCache && jwksCache.uri === jwksUri) {
      // キャッシュに無い kid → 鍵ローテーションの可能性。一度だけ強制再取得。
      await refresh();
      jwk = jwksCache?.keys.get(kid) ?? null;
    }
    return jwk;
  };
}

/** テスト用: JWKS キャッシュを初期化する。 */
export function __resetJwksCache(): void {
  jwksCache = null;
}
