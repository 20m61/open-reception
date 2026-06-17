import { NextResponse } from 'next/server';
import { appConfig } from '@/lib/config/app-config';

/**
 * kiosk API namespace のヘルスチェック。
 * 受付端末用 API は /api/kiosk/* に閉じ、管理 API とは責務を分離する (issue #24)。
 */
export function GET() {
  return NextResponse.json({
    area: 'kiosk',
    status: 'ok',
    appName: appConfig.name,
  });
}
