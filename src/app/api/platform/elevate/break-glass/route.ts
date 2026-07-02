import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { grantBreakGlass, elevationAuditMetadata } from '@/domain/auth/elevation';
import { recordDangerAction } from '@/lib/admin/audit';
import { authorizePlatformWithIdentity } from '@/lib/platform/request';
import { ELEVATION_COOKIE, issueElevationToken } from '@/lib/platform/elevation';
import { reauthenticate, type ReauthProvider } from '@/lib/platform/reauth';

/**
 * POST /api/platform/elevate/break-glass — break-glass 緊急昇格の発行 (issue #83 §3)。
 *
 * 障害時のみ使う緊急権限を、通常の JIT 昇格（/api/platform/elevate）から**発行経路ごと分離**する。
 * 通常昇格との違い:
 *   - **明示操作**: 別エンドポイント + `acknowledge:true`（緊急事態確認の解錠ステップ）必須。
 *   - **短い固定窓**: 15 分固定（通常の既定 30 分の半分・TTL 指定不可）。延長せず再発行させる。
 *   - **高重要度監査**: 発行・否認とも `privilege.break_glass` + severity='high' で記録し、
 *     break-glass 中の全 write にも metadata.breakGlass が付く（利用後レビュー対象, audit-logs で抽出可）。
 * 強制の仕組み（理由必須・再認証・sub 束縛・jti 失効・assertElevated）は通常昇格と同一で、
 * 緊急経路でも安全装置を一切緩めない（緩めるのは「平常時 UI に出さない」導線側のみ）。
 *
 * 認可: authorizePlatformWithIdentity()（未認証 401 / 非 developer 403）。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const auth = await authorizePlatformWithIdentity();
  if (!auth.ok) return auth.response;
  const actor = `platform:${auth.identity}`; // 監査/cookie の操作者識別（#264）。

  const body = (await request.json().catch(() => ({}))) as {
    reason?: unknown;
    provider?: unknown;
    credential?: unknown;
    acknowledge?: unknown;
  };
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason === '') return NextResponse.json({ error: 'reason_required' }, { status: 400 });
  // 解錠ステップ: UI のロック解除に対応するサーバ側の明示同意。誤送信・自動化スクリプトの
  // 「うっかり break-glass」を防ぐ（通常昇格 API を流用しても break-glass にはならない）。
  if (body.acknowledge !== true) {
    return NextResponse.json({ error: 'acknowledge_required' }, { status: 400 });
  }
  const provider: ReauthProvider = body.provider === 'cognito' ? 'cognito' : 'none';
  const credential = typeof body.credential === 'string' ? body.credential : '';

  const now = Date.now();
  // 監査は grant 前に組み立てられないため、否認/成功で共通の高重要度メタを使う。
  const reauth = await reauthenticate(provider, credential);
  if (!reauth.ok) {
    // 否認も break-glass の action で高重要度監査（理由は残すが credential は残さない）。
    await recordDangerAction({
      action: 'privilege.break_glass',
      target: { type: 'platform' },
      reason,
      metadata: { result: 'denied', why: reauth.reason, severity: 'high' },
      actor,
      request,
    });
    return NextResponse.json({ error: 'reauth_failed', reason: reauth.reason }, { status: 403 });
  }

  // 緊急対応は影響範囲が事前に読めないため platform 全体スコープ（{}）。その代わり窓を 15 分固定に絞る。
  const elevation = grantBreakGlass({ reason, scope: {} }, now);
  const token = await issueElevationToken(elevation, randomUUID(), auth.identity);

  await recordDangerAction({
    action: 'privilege.break_glass',
    target: { type: 'platform' },
    reason,
    metadata: { ...elevationAuditMetadata(elevation), result: 'granted' },
    actor,
    request,
  });

  // cookie 属性は通常昇格（/elevate）と同一（HttpOnly/SameSite=Strict/プロトコル判定 Secure）。
  const isHttps = new URL(request.url).protocol === 'https:';
  const res = NextResponse.json({ ok: true, until: elevation.until, breakGlass: true });
  res.cookies.set(ELEVATION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: isHttps,
    path: '/',
    maxAge: Math.max(0, Math.floor((elevation.until - now) / 1000)),
  });
  return res;
}
