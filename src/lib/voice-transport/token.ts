/**
 * 音声 Transport 接続の短命トークン (issue #369)。
 *
 * `src/lib/auth/kiosk-enrollment.ts` と同じ流儀: 汎用署名（HMAC-SHA256 / role+exp,
 * `src/lib/auth/session.ts`）を再利用し、role を専用値に限定して検証する。
 *
 * セキュリティ:
 *   - 秘密鍵は server 専用 `VOICE_TRANSPORT_TOKEN_SECRET`。実デプロイで未設定なら fail closed
 *     （音声チャンクという機微度の高いストリームを守るトークンのため、kiosk-enrollment と同様に
 *     厳格側へ倒す）。
 *   - claims は `tenantId/siteId/kioskId/receptionSessionId` を必ず含む（境界チェックは
 *     `@/domain/voice-transport/token` の `checkTokenBinding` が担う）。
 *   - 単回性（リプレイ拒否）は `jti` を `replay-guard.ts` の消費済み集合と突き合わせて実現する
 *     （このモジュールは署名のみを扱う）。
 *   - 平文トークンは発行 API レスポンスに一度だけ返し、永続化・監査・ログには残さない。
 */
import { signSession, verifySession } from '../auth/session';
import { serverSecret } from '../auth/server-secret';
import type { VoiceTransportTokenClaims } from '@/domain/voice-transport/types';

/** kiosk / kiosk-enroll と取り違えないための専用 role。 */
export const VOICE_TRANSPORT_TOKEN_ROLE = 'voice-transport';

/**
 * 既定有効期限（2 分）。トークンは WS ハンドシェイク開始までの短い窓を守るためのものであり、
 * 接続確立後の最大接続時間は別途 lifecycle 側（idle timeout / 最大接続時間）が制御する。
 */
export const DEFAULT_VOICE_TRANSPORT_TOKEN_TTL_MS = 2 * 60 * 1000;

export function getVoiceTransportTokenSecret(): string {
  return serverSecret('VOICE_TRANSPORT_TOKEN_SECRET', 'dev-insecure-voice-transport-secret', {
    failClosed: true,
  });
}

/**
 * 接続トークンを署名発行する。`now` はテストのため注入可能（既定 `Date.now()`）。
 */
export async function issueVoiceTransportToken(
  claims: VoiceTransportTokenClaims,
  ttlMs: number = DEFAULT_VOICE_TRANSPORT_TOKEN_TTL_MS,
  now: number = Date.now(),
): Promise<{ token: string; expiresAt: string }> {
  const exp = now + ttlMs;
  const token = await signSession(
    { role: VOICE_TRANSPORT_TOKEN_ROLE, exp, ...claims },
    getVoiceTransportTokenSecret(),
  );
  return { token, expiresAt: new Date(exp).toISOString() };
}

/**
 * 接続トークンを検証して claims を取り出す。署名 NG・exp 切れ・role 不一致・必須フィールド
 * 欠落はすべて null（呼び出し側は invalid_token として扱う）。**例外を投げない** — token API は
 * 常に構造化エラーレスポンスを返せるようにするため。
 *
 * exp 判定は `verifySession` が実時計（`Date.now()`）で行う。決定的なテストは
 * `issueVoiceTransportToken` の `now` 引数（issue 基準時刻）側で past を注入して行う
 * （`kiosk-enrollment.ts` と同じ流儀）。
 */
export async function readVoiceTransportToken(
  token: string | undefined,
): Promise<VoiceTransportTokenClaims | null> {
  const payload = await verifySession(token, getVoiceTransportTokenSecret());
  if (!payload) return null;
  if (payload.role !== VOICE_TRANSPORT_TOKEN_ROLE) return null;

  const { tenantId, siteId, kioskId, receptionSessionId, jti } = payload;
  if (
    typeof tenantId !== 'string' ||
    typeof siteId !== 'string' ||
    typeof kioskId !== 'string' ||
    typeof receptionSessionId !== 'string' ||
    typeof jti !== 'string' ||
    !tenantId ||
    !siteId ||
    !kioskId ||
    !receptionSessionId ||
    !jti
  ) {
    return null;
  }
  return { tenantId, siteId, kioskId, receptionSessionId, jti };
}
