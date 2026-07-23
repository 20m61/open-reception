import { NextResponse } from 'next/server';
import { getReservationService } from '@/lib/reservation/store';
import { readScope, resolveAdminActor, serviceResponse, toReservationId } from '@/lib/reservation/request';

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/admin/reservations/:id/qr — 予約 QR の再取得（#375 で不可へ変更）。
 *
 * #375 により生 token は永続化せず一方向 hash のみを保存する。QR/生 token は**発行時のみ**
 * （POST /api/admin/reservations の作成応答・POST /api/admin/reservations/:id/token の再発行応答）
 * に一度だけ返る。保存済みレコードからは復元できないため、このエンドポイントは QR 画像を
 * 再生成できない（一方向 hash の設計上の帰結）。
 *
 * fail-closed: 認証/認可/存在（テナント境界）を検証したうえで 410 Gone を返し、再取得には
 * 「再発行（reissue）で新しい QR を得る」ことを機械可読コードで案内する。UI（ReservationsManager）
 * は発行/再発行応答から QR を一度だけ表示する導線へ差し替える（次増分・orchestrator 配線）。
 */
export async function GET(request: Request, { params }: Ctx): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const url = new URL(request.url);
  const scope = readScope(url.searchParams);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });

  const { id } = await params;
  // 認可/存在/テナント境界の検証（漏れなく 401/403/404 を返すため get を通す）。
  const result = await getReservationService().get(
    actor,
    scope.tenantId,
    scope.siteId,
    toReservationId(id),
  );
  if (!result.ok) return serviceResponse(result);

  return NextResponse.json(
    {
      error: 'token_not_retrievable',
      message:
        'QR/token is shown only at issuance and is not stored in plaintext. Reissue the token to obtain a new QR.',
    },
    { status: 410, headers: { 'cache-control': 'private, no-store' } },
  );
}
