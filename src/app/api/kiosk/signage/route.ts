import { NextResponse } from 'next/server';
import { requireKioskSession } from '@/lib/kiosk/session-guard';
import { resolveKioskScope } from '@/lib/voice-transport/kiosk-scope';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import { defaultSiteIdFrom, defaultTenantIdFrom } from '@/lib/tenant/default-scope';
import { getKioskSignage } from '@/lib/signage/kiosk-signage';

/**
 * GET /api/kiosk/signage?tenantId=&siteId= — 受付端末向けの待機中サイネージ (issue #101)。
 *
 * 待機画面（/kiosk/signage）が消費する。再生可能（有効 + 内容が揃った）項目のみを返し、
 * 設定なし/無効なら enabled=false + 空配列を返す（読み込み失敗時も待機画面は壊れない）。
 * 来訪者の PII は含まない。
 */
export async function GET(): Promise<NextResponse> {
  const session = await requireKioskSession();
  if (!session) {
    return NextResponse.json(
      { error: 'forbidden', message: 'kiosk session required' },
      { status: 403 },
    );
  }
  // **スコープはリクエストではなくセッションから導出する** (#601)。以前は tenantId/siteId を
  // クエリで受けており、無認証と相まって **id を推測すれば他テナントの掲示が読めた**。
  // 端末レジストリ由来のスコープなら、端末は自分の掲示しか読めない。
  const scope = await resolveKioskScope(session.kioskId);
  const signage = await getKioskSignage(asTenantId(scope.tenantId), asSiteId(scope.siteId));
  return NextResponse.json(signage);
}
