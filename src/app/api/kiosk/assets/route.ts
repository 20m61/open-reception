import { NextResponse } from 'next/server';
import { getKioskAssets } from '@/lib/assets/asset-store';

/**
 * GET /api/kiosk/assets — 受付端末に適用するアクティブアセット (issue #27)。
 * 背景画像・fallback 画像の URL を返す。読み込み失敗時は受付端末側で fallback する。
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(await getKioskAssets());
}
