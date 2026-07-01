import { NextResponse } from 'next/server';
import { readJson } from '@/lib/data-stores/result-http';
import { asSiteId, type SiteStatus } from '@/domain/tenant/types';
import { getSiteService } from '@/lib/tenant/store';
import { readTenantScope, resolveAdminActor, siteResponse } from '@/lib/tenant/request';
import type { UpdateSitePatch } from '@/lib/tenant/site-service';

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET   /api/admin/sites/:id?tenantId= — 単一拠点取得（端末紐づけ集計つき） (issue #87)。
 * PATCH /api/admin/sites/:id           — 拠点名・状態（有効/停止）を更新する。
 *
 * 認証/認可/監査は service 層で #80 認可と PII なし監査を適用する。
 */
export async function GET(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const scope = readTenantScope(new URL(request.url).searchParams);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const { id } = await params;
  const result = await getSiteService().get(actor, scope.tenantId, asSiteId(id));
  return siteResponse(result);
}

export async function PATCH(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await readJson(request);
  const scope = readTenantScope((body ?? {}) as Record<string, unknown>);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const { id } = await params;
  const result = await getSiteService().update(
    actor,
    scope.tenantId,
    asSiteId(id),
    parseUpdateBody(body),
  );
  return siteResponse(result);
}

/** 更新ボディを UpdateSitePatch へ（指定されたフィールドのみ）。 */
function parseUpdateBody(body: unknown): UpdateSitePatch {
  if (typeof body !== 'object' || body === null) return {};
  const o = body as Record<string, unknown>;
  const patch: UpdateSitePatch = {};
  if (typeof o.name === 'string') patch.name = o.name;
  if (o.status === 'active' || o.status === 'suspended') patch.status = o.status as SiteStatus;
  return patch;
}
