import { NextResponse } from 'next/server';
import { getKioskAssets } from '@/lib/assets/asset-store';
import { isKioskFeatureEnabled } from '@/lib/platform/feature-flag-gate';
import { requireKioskSession } from '@/lib/kiosk/session-guard';

/**
 * GET /api/kiosk/assets — 受付端末に適用するアクティブアセット (issue #27)。
 * 背景画像・fallback 画像の URL を返す。読み込み失敗時は受付端末側で fallback する。
 *
 * #290: 機能フラグ `avatarReception` が無効なテナントでは、アバター関連の vrmUrl / fallbackImageUrl
 * を応答から落とす（クライアントは URL 未指定 = アバター無しで継続する）。backgroundUrl はアバター
 * 機能ではないため維持する。テナントは kiosk セッションの kioskId から解決する（未セッション時は
 * 既定テナント）。
 */
export async function GET(): Promise<NextResponse> {
  const session = await requireKioskSession();
  const [assets, avatarEnabled] = await Promise.all([
    getKioskAssets(),
    isKioskFeatureEnabled('avatarReception', session?.kioskId),
  ]);
  if (!avatarEnabled) {
    return NextResponse.json({ backgroundUrl: assets.backgroundUrl });
  }
  return NextResponse.json(assets);
}
