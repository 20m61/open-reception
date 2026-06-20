import { NextResponse } from 'next/server';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import { getKioskSignage } from '@/lib/signage/kiosk-signage';

/**
 * GET /api/kiosk/signage?tenantId=&siteId= — 受付端末向けの待機中サイネージ (issue #101)。
 *
 * 待機画面（/kiosk/signage）が消費する。再生可能（有効 + 内容が揃った）項目のみを返し、
 * 設定なし/無効なら enabled=false + 空配列を返す（読み込み失敗時も待機画面は壊れない）。
 * 来訪者の PII は含まない。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const tenantId = params.get('tenantId') ?? 'internal';
  const siteId = params.get('siteId') ?? 'default';
  const signage = await getKioskSignage(asTenantId(tenantId), asSiteId(siteId));
  return NextResponse.json(signage);
}
