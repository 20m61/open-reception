/**
 * 昇格前の再認証 (issue #83 AC10 / inc4b)。
 *
 * JIT 昇格（`/api/platform/elevate`）の直前に所持要素などで**再認証**させるための interface。
 * 実 MFA（Cognito `SOFTWARE_TOKEN_MFA` / TOTP）は実認証情報が要るため #65 にスタックし、本増分は
 * **interface + mock 先行**（CLAUDE.md の外部認証情報方針）。
 *
 * セキュリティ既定は「安全側」: mock は環境変数 `PLATFORM_REAUTH_MOCK` が**設定されている時のみ**有効。
 * 未設定の環境（= 本番想定）では `unsupported` を返し、実 MFA(#65) が入るまで**昇格を成立させない**。
 */
import { timingSafeEqual } from 'node:crypto';

export type ReauthProvider = 'none' | 'cognito';
export type ReauthResult = { ok: true } | { ok: false; reason: 'invalid_credential' | 'unsupported' };

/** 定数時間比較（長さ差でも早期 return しない）。 */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * 再認証を検証する。inc4b では `provider='none'`（mock）のみ実装。
 * mock は `PLATFORM_REAUTH_MOCK` と厳密一致した時のみ成功（未設定なら常に unsupported）。
 * トグルは env を**直読み**する（`serverSecret` の dev-fallback 警告を出さない。ここは署名鍵ではない）。
 */
export async function reauthenticate(provider: ReauthProvider, credential: string): Promise<ReauthResult> {
  if (provider === 'none') {
    const expected = process.env.PLATFORM_REAUTH_MOCK ?? '';
    if (expected === '') return { ok: false, reason: 'unsupported' }; // mock 無効 → 昇格不可（実 MFA #65 待ち）
    return safeEqual(credential, expected) ? { ok: true } : { ok: false, reason: 'invalid_credential' };
  }
  // cognito TOTP（SOFTWARE_TOKEN_MFA）は #65 で実装。
  return { ok: false, reason: 'unsupported' };
}
