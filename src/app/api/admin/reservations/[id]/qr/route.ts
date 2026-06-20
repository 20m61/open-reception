import { NextResponse } from 'next/server';
import { getReservationService } from '@/lib/reservation/store';
import { resolveCheckinBaseUrl } from '@/lib/reservation/base-url';
import { renderReservationQrSvg, svgToDataUrl } from '@/lib/reservation/qr';
import { readScope, resolveAdminActor, serviceResponse, toReservationId } from '@/lib/reservation/request';

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/admin/reservations/:id/qr?tenantId=&siteId=&format= — 予約 QR 画像 (issue #97)。
 *
 * 予約の現行 token から checkin URL を作り、QR を SVG（既定）または JSON(dataUrl) で返す。
 * - 認証/認可/テナント境界は service.get（#80 認可）に委譲する。
 * - QR に載せるのは token 参照 URL のみ。PII は載せない。
 * - 基底オリジンはサーバ側で解決し、クライアント入力を信用しない（base-url.ts）。
 * - 失効/期限切れ/使用済みでも画像生成自体は返す（受付端末側で利用可否を判定する）。
 *
 * format: 'svg'（既定・image/svg+xml）| 'json'（{ dataUrl }）。
 */
export async function GET(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const url = new URL(request.url);
  const scope = readScope(url.searchParams);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });

  const { id } = await params;
  const result = await getReservationService().get(
    actor,
    scope.tenantId,
    scope.siteId,
    toReservationId(id),
  );
  if (!result.ok) return serviceResponse(result);

  const baseUrl = resolveCheckinBaseUrl(request);
  if (!baseUrl) {
    return NextResponse.json(
      { error: 'invalid_input', message: 'could not resolve checkin base url' },
      { status: 400 },
    );
  }

  const svg = renderReservationQrSvg(baseUrl, result.value.token);
  const format = url.searchParams.get('format');
  if (format === 'json') {
    return NextResponse.json({ dataUrl: svgToDataUrl(svg) });
  }
  return new NextResponse(svg, {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      // token を含むため共有キャッシュには載せない。
      'cache-control': 'private, no-store',
    },
  });
}
