import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { elevationAuditMetadata } from '@/domain/auth/elevation';
import { recordDangerAction } from '@/lib/admin/audit';
import { authorizePlatformWithIdentity } from '@/lib/platform/request';
import { ELEVATION_COOKIE, readElevation } from '@/lib/platform/elevation';
import { revokeElevationJti } from '@/lib/platform/elevation-jti-store';

/**
 * POST /api/platform/elevate/end — JIT 昇格の即時終了（期限前の取り消し, issue #264 対応案 2）。
 *
 * 本人の有効な昇格 cookie の jti を失効ストアで revoke する。失効後は cookie が手元に残っていても
 * `assertElevated` が拒否するため、漏洩を疑ったとき・作業完了時に昇格窓を即座に閉じられる。
 *
 * - 認可: authorizePlatformWithIdentity（未認証 401 / 非 developer 403）。
 * - 冪等: 昇格 cookie が無い/無効/失効済みでも 200 `{ ok:true, ended:false }`（終了操作にエラー UX は不要）。
 * - 他人の cookie（sub 不一致）は revoke しない（別 developer の昇格を横取り失効させない。自分の
 *   昇格は自分で end する。漏洩 cookie の replay 自体は sub 束縛が既に拒否している）。
 * - 監査: 実際に失効させたときのみ記録。専用 AuditAction の追加は共有ファイル（log.ts）編集になるため
 *   行わず、既存 `privilege.elevated` + metadata.result='revoked' で表す（発行時は result なし）。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await authorizePlatformWithIdentity();
  if (!auth.ok) return auth.response;

  const token = (await cookies()).get(ELEVATION_COOKIE)?.value;
  const elevation = await readElevation(token);
  let ended = false;
  if (elevation !== null && elevation.sub === auth.identity) {
    // revoke は冪等（既失効でも true）。「今回の呼び出しで失効状態にある」ことを ended に反映する。
    ended = await revokeElevationJti(elevation.jti, Date.now());
    if (ended) {
      await recordDangerAction({
        action: 'privilege.elevated',
        target: { type: 'platform' },
        metadata: { ...elevationAuditMetadata(elevation), result: 'revoked' },
        actor: `platform:${auth.identity}`,
        request,
      });
    }
  }

  // cookie はサーバ側 jti 失効で既に無力化済み。削除は UI 状態を揃えるための後始末。
  const res = NextResponse.json({ ok: true, ended });
  res.cookies.set(ELEVATION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'strict',
    secure: new URL(request.url).protocol === 'https:',
    path: '/',
    maxAge: 0,
  });
  return res;
}
