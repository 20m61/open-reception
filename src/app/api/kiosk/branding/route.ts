import { NextResponse } from 'next/server';
import { getBrandingSettings } from '@/lib/branding/branding-store';

/**
 * GET /api/kiosk/branding — 受付端末向けのブランディング設定 (issue #88)。
 * 秘匿情報は無く、ロゴ（公開アセット）・アクセント色・社名のみ公開する。
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(await getBrandingSettings());
}
