/**
 * 接続トークンの純検証ロジック (issue #369)。
 *
 * 署名・有効期限検証（HMAC / exp）は I/O を伴うため `src/lib/voice-transport/token.ts` が
 * 担う。ここは「claims が接続文脈と一致するか」「jti が既に消費済みか」だけを扱う純関数で、
 * テナント/端末/受付セッションの越境拒否ロジックを単体テストしやすくする。
 */
import type {
  VoiceTransportConnectionContext,
  VoiceTransportTokenClaims,
  VoiceTransportTokenRejectionReason,
} from './types';

/**
 * トークンの claims が接続文脈（クライアントが今まさに接続しようとしている
 * tenant/site/kiosk/reception）と完全一致するかを検証する。
 *
 * 判定順序は tenant → site → kiosk → reception。テナント境界が最も外側の信頼境界であり、
 * 越境時は内側の一致有無に関わらず最初に検出させる（監査・ログの原因特定を単純にするため）。
 *
 * 一致すれば null、不一致なら最初に見つかった違反理由を返す。
 */
export function checkTokenBinding(
  claims: VoiceTransportTokenClaims,
  context: VoiceTransportConnectionContext,
): VoiceTransportTokenRejectionReason | null {
  if (claims.tenantId !== context.tenantId) return 'tenant_mismatch';
  if (claims.siteId !== context.siteId) return 'site_mismatch';
  if (claims.kioskId !== context.kioskId) return 'kiosk_mismatch';
  if (claims.receptionSessionId !== context.receptionSessionId) return 'reception_mismatch';
  return null;
}

/** jti が既に消費済み集合に含まれているか（リプレイ判定の純ロジック）。 */
export function isReplayedJti(jti: string, consumed: ReadonlySet<string>): boolean {
  return consumed.has(jti);
}
