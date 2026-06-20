import { NextResponse } from 'next/server';
import { listAuditLogs } from '@/lib/mock-backend/reception-log-store';

/**
 * GET /api/admin/audit — 監査ログ一覧 (issue #19, #29)。
 * 受付ライフサイクル・管理操作の監査証跡を返す（PII を含めない）。
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ items: await listAuditLogs() });
}
