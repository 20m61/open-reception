/**
 * JIT 昇格の署名 cookie (issue #83 AC5/AC10 / inc4b)。
 *
 * 昇格（inc4a の純ドメイン `Elevation`）を**独立した短命署名 cookie** `platform_elevation` に載せる。
 * admin セッションは SSO トークン由来（`resolveAdminActor`）で書き換え可能な署名 cookie が常在しないため、
 * 昇格は別 cookie に分離して既存ログインを壊さない。署名は既存 `signSession/verifySession`（HMAC-SHA256
 * + exp）を再利用し、新しい暗号は導入しない。
 *
 * セキュリティ: HttpOnly + Secure + SameSite=Strict。write ルートは `authorizePlatform`（developer 検証）と
 * 二重化して使う（cookie 単体では write に至らない）。per-subject 束縛は Actor に安定 subject が無いため
 * 本増分では未実施（hardening は subject 露出とセットで別途）。secret は admin/kiosk と別 env。
 */
import { type Elevation, type ElevationScope } from '@/domain/auth/elevation';
import { serverSecret } from '@/lib/auth/server-secret';
import { signSession, verifySession } from '@/lib/auth/session';

export const ELEVATION_COOKIE = 'platform_elevation';

/** 署名 cookie に載せる昇格クレーム。`exp` は verifySession の期限検証に使う（= Elevation.until）。 */
type ElevationClaim = {
  role: 'platform_elevation';
  exp: number;
  reason: string;
  scope: ElevationScope;
  jti: string;
};

function elevationSecret(): string {
  return serverSecret('PLATFORM_ELEVATION_SECRET', 'dev-insecure-elevation-secret');
}

/** 昇格を署名トークン（cookie 値）へ。`jti` はリプレイ/失効検知用。 */
export async function issueElevationToken(elevation: Elevation, jti: string): Promise<string> {
  const claim: ElevationClaim = {
    role: 'platform_elevation',
    exp: elevation.until,
    reason: elevation.reason,
    scope: elevation.scope,
    jti,
  };
  return signSession(claim, elevationSecret());
}

/**
 * cookie 値から昇格を復元する。署名不正/期限切れ/role 不一致は null。
 * 期限は verifySession が Date.now() で検証するため、失効トークンは自然に null になる。
 */
export async function readElevation(token: string | undefined): Promise<Elevation | null> {
  const payload = await verifySession(token, elevationSecret());
  if (!payload || payload.role !== 'platform_elevation') return null;
  const scope = (payload.scope ?? {}) as ElevationScope;
  return {
    until: payload.exp,
    reason: typeof payload.reason === 'string' ? payload.reason : '',
    scope: {
      tenantId: scope.tenantId,
      siteId: scope.siteId,
      deviceId: scope.deviceId,
    },
  };
}
