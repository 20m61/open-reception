import { NextResponse } from 'next/server';
import { listAuditLogs } from '@/lib/mock-backend/reception-log-store';
import {
  assertCanRead,
  defaultAdminTenantId,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';

/**
 * GET /api/admin/audit — 監査ログ一覧 (issue #19, #29)。
 * 受付ライフサイクル・管理操作の監査証跡を返す（PII を含めない）。
 *
 * 認可（#91 inc2）: route 側で実 actor を解決し `requireActor` + `assertCanRead`
 * で最終認可を行う（監査閲覧は read 権限が前提）。
 */
export async function GET(): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanRead(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  return NextResponse.json({ items: await listAuditLogs() });
}
