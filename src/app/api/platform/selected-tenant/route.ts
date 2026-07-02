import { NextResponse } from 'next/server';
import { asTenantId } from '@/domain/tenant/types';
import { getTenantStore } from '@/lib/tenant/store';
import { authorizePlatformWithIdentity } from '@/lib/platform/request';
import { recordPlatformReadAudit } from '@/lib/platform/read-audit';
import { SELECTED_TENANT_COOKIE } from '@/lib/platform/selected-tenant';
import { readJson } from '@/lib/data-stores/result-http';

/**
 * PUT /api/platform/selected-tenant — 対象テナント切替 (issue #83 §5 / inc5b)。
 *
 * TenantSwitcher の適用をサーバ側 API に通し、対象テナント切替を確実に監査
 * （platform.tenant_scope.switched, actor 帰属・対象明示）へ残す。従来はクライアントが
 * `document.cookie` を直接書いており切替がサーバから観測できなかったため、切替の適用点を
 * 本 API に集約した（切替＝監査対象操作、#83 §5）。
 *
 * body: `{ tenantId: string | null }`。null / '' は「全テナント横断」へ戻す。
 * 不変条件:
 *   1. 認可は authorizePlatformWithIdentity（未認証 401 / 非 developer 403）。
 *   2. 存在しないテナントへの切替は 404（消えたテナントを選択させない、#268 実在チェックの型）。
 *   3. **audit-first**: 監査を記録してから Cookie を確定する。記録失敗は 500 で切替不成立
 *      （未監査の切替を成立させない）。
 *   4. Cookie（`or_platform_tenant`）は選択テナント id のみ（PII・機微値なし）。TenantSwitcher が
 *      `document.cookie` から初期選択を読むため httpOnly にしない。
 */
export async function PUT(request: Request): Promise<NextResponse> {
  const auth = await authorizePlatformWithIdentity();
  if (!auth.ok) return auth.response;

  const body = (await readJson(request)) as { tenantId?: unknown } | null;
  const raw = body?.tenantId;
  if (raw !== null && typeof raw !== 'string') {
    return NextResponse.json(
      { error: 'invalid_input', message: 'tenantId must be string or null' },
      { status: 400 },
    );
  }
  const tenantId = raw === null || raw === '' ? null : raw;

  if (tenantId !== null) {
    const tenant = await getTenantStore().tenants.getTenant(asTenantId(tenantId));
    if (!tenant) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
  }

  try {
    await recordPlatformReadAudit({
      action: 'platform.tenant_scope.switched',
      identity: auth.identity,
      // 横断へ戻す操作も「スコープ変更」として監査する（対象は platform 全体・scope:all）。
      target: tenantId ? { type: 'tenant', id: tenantId } : { type: 'platform' },
      metadata: tenantId ? undefined : { scope: 'all' },
      request,
    });
  } catch {
    // audit-first: 監査に残せない切替は成立させない（Cookie 未設定のまま失敗を明示）。
    return NextResponse.json({ error: 'audit_failed' }, { status: 500 });
  }

  const res = NextResponse.json({ ok: true, tenantId });
  res.cookies.set(SELECTED_TENANT_COOKIE, tenantId ?? '', {
    path: '/',
    sameSite: 'lax',
    // TenantSwitcher が document.cookie から初期選択を読むため httpOnly にしない（値は運用 id のみ）。
    httpOnly: false,
    secure: new URL(request.url).protocol === 'https:',
  });
  return res;
}
