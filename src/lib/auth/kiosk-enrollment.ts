/**
 * 受付端末エンロールトークン (docs/reception-issuance-design.md §3)。
 *
 * 管理画面が発行する「受付URL/QR」に埋め込む使い捨て・期限付きトークン。
 * 端末が一度開くと kiosk セッション（src/lib/auth/kiosk.ts）に交換し、トークンは無効化する。
 *
 * 汎用署名（src/lib/auth/session.ts: HMAC-SHA256 / role+exp）を再利用し、role を限定して検証する。
 * 単回性は Device.enrollmentTokenId（jti）との突き合わせで担保する（このモジュールは署名のみ）。
 *
 * セキュリティ:
 *   - 秘密鍵は server 専用 `KIOSK_ENROLLMENT_SECRET`。client / bundle には出さない。
 *   - 平文トークンは発行 API レスポンスに一度だけ返し、永続化・監査・ログには残さない。
 */
import { randomUUID } from 'node:crypto';
import { signSession, verifySession } from './session';
import { serverSecret } from './server-secret';

/** kiosk セッション（role='kiosk'）と取り違えないための専用 role。 */
export const ENROLLMENT_ROLE = 'kiosk-enroll';

/** 既定有効期限（15 分）。発行直後に受付端末で読み取る短命運用を想定。 */
export const DEFAULT_ENROLLMENT_TTL_MS = 15 * 60 * 1000;

export function getEnrollmentSecret(): string {
  // 未認証の受付エンロールの署名鍵。実デプロイで未設定なら fail closed（トークン偽造防止）。
  return serverSecret('KIOSK_ENROLLMENT_SECRET', 'dev-insecure-kiosk-enroll-secret', {
    failClosed: true,
  });
}

/** エンロールトークンが束ねる主体（テナント境界つき端末参照 + 単回検証用 jti）。 */
export type EnrollmentClaims = {
  tenantId: string;
  siteId: string;
  deviceId: string;
  /** 使い捨て識別子。Device.enrollmentTokenId と一致する場合のみ消費可能。 */
  jti: string;
};

/** 新しい jti を採番する（発行のたびに更新し旧 URL を無効化する）。 */
export function newEnrollmentJti(): string {
  return randomUUID();
}

/**
 * エンロールトークンを署名発行する。`expiresAt` は表示・期限案内用に併せて返す。
 * `now` は決定的テストのため注入可能（既定は Date.now）。
 */
export async function issueEnrollmentToken(
  claims: EnrollmentClaims,
  ttlMs: number = DEFAULT_ENROLLMENT_TTL_MS,
  now: number = Date.now(),
): Promise<{ token: string; expiresAt: string }> {
  const exp = now + ttlMs;
  const token = await signSession({ role: ENROLLMENT_ROLE, exp, ...claims }, getEnrollmentSecret());
  return { token, expiresAt: new Date(exp).toISOString() };
}

/**
 * エンロールトークンを検証してクレームを取り出す。署名 NG・exp 切れ・role 不一致・
 * 必須フィールド欠落はすべて null（呼び出し側は invalid_token として扱う）。
 */
export async function readEnrollmentToken(
  token: string | undefined,
): Promise<EnrollmentClaims | null> {
  const payload = await verifySession(token, getEnrollmentSecret());
  if (!payload || payload.role !== ENROLLMENT_ROLE) return null;
  const { tenantId, siteId, deviceId, jti } = payload;
  if (
    typeof tenantId !== 'string' ||
    typeof siteId !== 'string' ||
    typeof deviceId !== 'string' ||
    typeof jti !== 'string'
  ) {
    return null;
  }
  return { tenantId, siteId, deviceId, jti };
}
