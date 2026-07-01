import { NextResponse } from 'next/server';
import { readJson } from '@/lib/data-stores/result-http';
import { getReservationService } from '@/lib/reservation/store';
import {
  parseCreateBody,
  readScope,
  resolveAdminActor,
  serviceResponse,
} from '@/lib/reservation/request';

/**
 * GET /api/admin/reservations?tenantId=&siteId= — テナント/サイトの来訪予約一覧 (issue #97)。
 * POST /api/admin/reservations — 来訪予約を作成し token を発行する。
 *
 * 認証: 管理セッション必須（無効なら 401）。
 * 認可: #80 の canAccessSite 純関数で tenantId/siteId 境界を判定する。
 * 監査: 作成・token 発行を PII なしで記録する。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const scope = readScope(new URL(request.url).searchParams);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const result = await getReservationService().list(actor, scope.tenantId, scope.siteId);
  return serviceResponse(result);
}

export async function POST(request: Request): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await readJson(request);
  const scope = readScope((body ?? {}) as Record<string, unknown>);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const parsed = parseCreateBody(body, scope.tenantId, scope.siteId);
  if (!parsed.ok) return NextResponse.json(parsed.error, { status: 400 });
  const result = await getReservationService().create(actor, parsed.value);
  return serviceResponse(result, 201);
}
