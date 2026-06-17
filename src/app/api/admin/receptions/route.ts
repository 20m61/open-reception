import { NextResponse } from 'next/server';
import { listReceptionLogs } from '@/lib/mock-backend/reception-log-store';

/**
 * GET /api/admin/receptions — 受付履歴一覧 (issue #19, #22)。
 * 来訪者 PII を含まない運用ログのみを返す。
 *
 * NOTE: 管理 API の認証・認可は #24 で middleware により付与する。
 * 現時点では kiosk API と namespace を分離して責務境界を明確化している。
 */
export function GET(): NextResponse {
  return NextResponse.json({ items: listReceptionLogs() });
}
