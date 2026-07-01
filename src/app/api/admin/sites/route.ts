import { NextResponse } from 'next/server';
import { readJson } from '@/lib/data-stores/result-http';
import { getSiteService } from '@/lib/tenant/store';
import { readTenantScope, resolveAdminActor, siteResponse } from '@/lib/tenant/request';

/**
 * GET  /api/admin/sites?tenantId= — テナント配下の拠点一覧（端末紐づけ集計つき） (issue #87)。
 * POST /api/admin/sites             — 拠点を作成する。
 *
 * 認証: 管理セッション必須（無効なら 401）。
 * 認可: #80 の canAccessTenant / canAccessSite 純関数で tenantId/siteId 境界を判定する。
 * 監査: 作成を PII なしで記録する。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const scope = readTenantScope(new URL(request.url).searchParams);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const result = await getSiteService().list(actor, scope.tenantId);
  return siteResponse(result);
}

export async function POST(request: Request): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await readJson(request);
  const scope = readTenantScope((body ?? {}) as Record<string, unknown>);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const name = typeof (body as Record<string, unknown>)?.name === 'string'
    ? ((body as Record<string, unknown>).name as string)
    : '';
  const result = await getSiteService().create(actor, { tenantId: scope.tenantId, name });
  return siteResponse(result, 201);
}
