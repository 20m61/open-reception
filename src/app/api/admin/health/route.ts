import { NextResponse } from 'next/server';
import { appConfig } from '@/lib/config/app-config';

/**
 * admin API namespace のヘルスチェック。
 * 管理 API は /api/admin/* に閉じ、認証・認可必須 (issue #22, #24)。
 * 認可ガードは後続 issue で実装する。
 */
export function GET() {
  return NextResponse.json({
    area: 'admin',
    status: 'ok',
    appName: appConfig.name,
  });
}
