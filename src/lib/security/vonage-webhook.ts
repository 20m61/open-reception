/**
 * Vonage signed webhook の検証 (issue #4 MVP 1)。
 *
 * Vonage は webhook に `Authorization: Bearer <JWT>` を付ける。JWT は**アカウントの
 * signature secret による HS256** で署名され、claims に本文の SHA-256（`payload_hash`）を含む。
 * 検証は 3 つを揃えて初めて成立する:
 *
 * 1. **署名** … 誰が送ったか。これが無いと誰でも通話イベントを注入して取次を進められる。
 * 2. **`payload_hash`** … 何を送ったか。署名だけ見ると、正規のトークンを再利用して
 *    **本文だけ差し替え**られる（別の通話 UUID・別の結果を注入できる）。
 * 3. **`iat` の鮮度** … いつ送ったか。記録した正規リクエストの再送を弾く。
 *
 * `jti` は重複配信の判定材料として返すだけで、ここでは覚えない
 * （二重処理の防止は `domain/routing/ledger.ts` と同じく呼び出し側の責務）。
 *
 * **server-only**（`node:crypto` を使う）。'use client' から import しないこと。
 * 純関数（時刻は `nowSec` で注入）で、`src/server/notification/authorizer.ts` の
 * `verifySiteToken` と同じ流儀に揃えている。
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * `iat` の許容ずれ（秒）。前後どちらにも適用する。
 * 長くすると記録済みリクエストの再送窓が広がり、短くするとサーバ間の時刻ずれで正規の
 * webhook を落とす。5 分は Vonage の推奨と一般的な NTP ずれの折り合い。
 */
export const REPLAY_WINDOW_SECONDS = 300;

export type VonageWebhookVerification =
  | { readonly verified: true; readonly jti: string }
  | { readonly verified: false; readonly reason: VonageWebhookRejection };

/** 拒否理由。**値・本文・トークンを含めない**（ログや応答に出しても漏れないようにする）。 */
export type VonageWebhookRejection =
  | 'no_signature_secret'
  | 'missing_authorization'
  | 'malformed_token'
  | 'unsupported_alg'
  | 'bad_signature'
  | 'missing_payload_hash'
  | 'payload_hash_mismatch'
  | 'missing_iat'
  | 'stale'
  | 'missing_jti';

export type VerifyVonageWebhookParams = {
  readonly authorization: string | undefined;
  /** 署名対象そのもの。パース前の生ボディを渡すこと（再シリアライズすると hash がずれる）。 */
  readonly rawBody: string;
  readonly signatureSecret: string;
  readonly nowSec: number;
};

function reject(reason: VonageWebhookRejection): VonageWebhookVerification {
  return { verified: false, reason };
}

/** `Bearer <token>` を取り出す。スキームは RFC 6750 に従い case-insensitive。 */
function extractBearer(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer[ ]+(.+)$/i.exec(authorization.trim());
  return match?.[1];
}

function decodeJson(segment: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function verifyVonageWebhook(
  params: VerifyVonageWebhookParams,
): VonageWebhookVerification {
  // 検証鍵が無いなら「検証できていない」。通すと署名検証が実質無効になる。
  if (!params.signatureSecret) return reject('no_signature_secret');

  const token = extractBearer(params.authorization);
  if (!token) return reject('missing_authorization');

  const parts = token.split('.');
  if (parts.length !== 3) return reject('malformed_token');
  const [headerSeg, payloadSeg, signatureSeg] = parts;
  if (!headerSeg || !payloadSeg || !signatureSeg) return reject('malformed_token');

  const header = decodeJson(headerSeg);
  if (!header) return reject('malformed_token');
  // **アルゴリズムを固定する。** トークン側の申告に従うと `none` や非対称鍵を名乗られて
  // 検証を素通りされる（alg confusion）。
  if (header.alg !== 'HS256') return reject('unsupported_alg');

  const expected = createHmac('sha256', params.signatureSecret)
    .update(`${headerSeg}.${payloadSeg}`)
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signatureSeg, 'base64url');
  } catch {
    return reject('bad_signature');
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return reject('bad_signature');
  }

  const claims = decodeJson(payloadSeg);
  if (!claims) return reject('malformed_token');

  const payloadHash = claims.payload_hash;
  if (typeof payloadHash !== 'string' || payloadHash === '') return reject('missing_payload_hash');
  const actualHash = createHash('sha256').update(params.rawBody).digest('hex');
  // hash 同士の比較なので長さは常に一致するが、`timingSafeEqual` に揃えておく。
  const a = Buffer.from(actualHash, 'utf8');
  const b = Buffer.from(payloadHash, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return reject('payload_hash_mismatch');

  const iat = claims.iat;
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return reject('missing_iat');
  if (Math.abs(params.nowSec - iat) > REPLAY_WINDOW_SECONDS) return reject('stale');

  const jti = claims.jti;
  if (typeof jti !== 'string' || jti === '') return reject('missing_jti');

  return { verified: true, jti };
}
