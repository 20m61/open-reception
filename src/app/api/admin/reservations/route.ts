import { NextResponse } from 'next/server';
import { readJson } from '@/lib/data-stores/result-http';
import { renderReservationQrDataUrl } from '@/lib/reservation/qr';
import { resolveCheckinBaseUrl } from '@/lib/reservation/base-url';
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
  // 生 token は一度きり応答(#375)。UI がその場で QR を表示できるよう qrDataUrl を同梱する
  // (サーバ側描画。以後は保存 hash から再生成できない)。
  if (result.ok) {
    // QR 宛先はサーバ権威の解決器を使う(request 由来 origin を信用しない — base-url.ts の方針)。
    const origin = resolveCheckinBaseUrl(request);
    if (!origin) {
      return NextResponse.json({ error: 'base_url_unresolved' }, { status: 400 });
    }
    return NextResponse.json(
      { ...result.value, qrDataUrl: renderReservationQrDataUrl(origin, result.value.token) },
      { status: 201, headers: { 'cache-control': 'private, no-store' } },
    );
  }
  return serviceResponse(result, 201);
}
