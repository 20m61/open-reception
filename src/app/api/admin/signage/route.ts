import { NextResponse } from 'next/server';
import { readJson } from '@/lib/data-stores/result-http';
import { getSignageService } from '@/lib/signage/store';
import {
  parseUpdateBody,
  readScope,
  resolveAdminActor,
  serviceResponse,
} from '@/lib/signage/request';

/**
 * GET /api/admin/signage?tenantId=&siteId= — サイトの待機中サイネージ設定 (issue #101)。
 * PUT /api/admin/signage                   — サイネージ設定を検証して保存する。
 *
 * 認証: 管理セッション必須（無効なら 401）。
 * 認可: #80 の canAccessSite 純関数で tenantId/siteId 境界・write 権限を判定する
 *       （viewer 書込不可・他テナント越境拒否）。
 * 監査: 更新を PII なしで 'signage.updated' として記録する。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const scope = readScope(new URL(request.url).searchParams);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const result = await getSignageService().get(actor, scope.tenantId, scope.siteId);
  return serviceResponse(result);
}

export async function PUT(request: Request): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await readJson(request);
  const scope = readScope((body ?? {}) as Record<string, unknown>);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const input = parseUpdateBody(body, scope.tenantId, scope.siteId);
  const result = await getSignageService().update(actor, input);
  return serviceResponse(result);
}
