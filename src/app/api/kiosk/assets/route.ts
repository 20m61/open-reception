import { NextResponse } from 'next/server';
import { getKioskAssets } from '@/lib/assets/asset-store';
import { isKioskFeatureEnabled } from '@/lib/platform/feature-flag-gate';

/**
 * GET /api/kiosk/assets — 受付端末に適用するアクティブアセット (issue #27)。
 * 背景画像・fallback 画像の URL を返す。読み込み失敗時は受付端末側で fallback する。
 *
 * #290 item4: 機能フラグ `avatarReception` が無効なテナント（既定スコープ）では、アバター関連の
 * vrmUrl / fallbackImageUrl を応答から落とす（クライアントは URL 未指定 = アバター無しで継続する）。
 * backgroundUrl はアバター機能ではないため維持する。
 */
export async function GET(): Promise<NextResponse> {
  const [assets, avatarEnabled] = await Promise.all([
    getKioskAssets(),
    isKioskFeatureEnabled('avatarReception'),
  ]);
  if (!avatarEnabled) {
    return NextResponse.json({ backgroundUrl: assets.backgroundUrl });
  }
  return NextResponse.json(assets);
}
