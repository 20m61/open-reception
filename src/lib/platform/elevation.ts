/**
 * JIT 昇格の署名 cookie (issue #83 AC5/AC10 / inc4b)。
 *
 * 昇格（inc4a の純ドメイン `Elevation`）を**独立した短命署名 cookie** `platform_elevation` に載せる。
 * admin セッションは SSO トークン由来（`resolveAdminActor`）で書き換え可能な署名 cookie が常在しないため、
 * 昇格は別 cookie に分離して既存ログインを壊さない。署名は既存 `signSession/verifySession`（HMAC-SHA256
 * + exp）を再利用し、新しい暗号は導入しない。
 *
 * セキュリティ: HttpOnly + Secure + SameSite=Strict。write ルートは `authorizePlatform`（developer 検証）と
 * 二重化して使う（cookie 単体では write に至らない）。per-subject 束縛は `sub`（#264）、期限前の
 * 取り消しは jti 失効ストア（#264 対応案 2、elevation-jti-store）で行う。secret は admin/kiosk と別 env。
 */
import { type Elevation, type ElevationScope } from '@/domain/auth/elevation';
import { serverSecret } from '@/lib/auth/server-secret';
import { signSession, verifySession } from '@/lib/auth/session';
import { registerElevationJti } from './elevation-jti-store';

export const ELEVATION_COOKIE = 'platform_elevation';

/** 署名 cookie に載せる昇格クレーム。`exp` は verifySession の期限検証に使う（= Elevation.until）。 */
type ElevationClaim = {
  role: 'platform_elevation';
  exp: number;
  reason: string;
  scope: ElevationScope;
  jti: string;
  /** 昇格した操作者の identity (issue #264)。破壊的操作の監査 actor に使う。 */
  sub: string;
  /** break-glass 区分 (issue #83 §3)。欠落（既存 cookie）は非 break-glass として扱う（後方互換）。 */
  breakGlass?: true;
};

function elevationSecret(): string {
  // 新規トラストルート。デプロイ環境で未設定なら **fail-closed**（throw）。公開 dev fallback で
  // 署名すると昇格 cookie を offline 偽造され得るため（Secrets Manager #194 で注入）。
  return serverSecret('PLATFORM_ELEVATION_SECRET', 'dev-insecure-elevation-secret', { failClosed: true });
}

/**
 * 昇格を署名トークン（cookie 値）へ。`jti` はリプレイ/失効検知用、`sub` は操作者 identity。
 * 発行 = 失効ストアへの記録（#264）。assertElevated は **fail-closed**（記録の無い jti は無効）で
 * 検証するため、署名だけしてストアに記録しないトークンは使えない（発行経路をここに一本化する）。
 */
export async function issueElevationToken(elevation: Elevation, jti: string, sub: string): Promise<string> {
  const claim: ElevationClaim = {
    role: 'platform_elevation',
    exp: elevation.until,
    reason: elevation.reason,
    scope: elevation.scope,
    jti,
    sub,
  };
  // break-glass（#83 §3）は claim にも区分を残し、write 監査の高重要度マークへ復元する。
  if (elevation.breakGlass) claim.breakGlass = true;
  await registerElevationJti({ jti, sub, expiresAt: elevation.until });
  return signSession(claim, elevationSecret());
}

/** 復元した昇格（domain Elevation ＋ 操作者 identity `sub` ＋ 失効チェック用 `jti`）。 */
export type ReadElevation = Elevation & { sub: string; jti: string };

/**
 * cookie 値から昇格を復元する。署名不正/期限切れ/role 不一致は null。
 * 期限は verifySession が Date.now() で検証するため、失効トークンは自然に null になる。
 */
export async function readElevation(token: string | undefined): Promise<ReadElevation | null> {
  const payload = await verifySession(token, elevationSecret());
  if (!payload || payload.role !== 'platform_elevation') return null;
  // 操作者 identity(sub) は #264 で必須。欠落（#264 前の cookie 等）は無効扱いにし、'platform:unknown'
  // での監査を防ぐ（短命 cookie なので再昇格で解消・安全側）。
  if (typeof payload.sub !== 'string' || payload.sub === '') return null;
  // jti も必須（#264 対応案 2）。欠落トークンは失効追跡できないため無効扱い（fail-closed）。
  if (typeof payload.jti !== 'string' || payload.jti === '') return null;
  const scope = (payload.scope ?? {}) as ElevationScope;
  return {
    until: payload.exp,
    reason: typeof payload.reason === 'string' ? payload.reason : '',
    scope: {
      tenantId: scope.tenantId,
      siteId: scope.siteId,
      deviceId: scope.deviceId,
    },
    sub: payload.sub,
    jti: payload.jti,
    // break-glass 区分 (#83 §3)。欠落した既存 cookie は非 break-glass（後方互換）。
    ...(payload.breakGlass === true ? { breakGlass: true as const } : {}),
  };
}
