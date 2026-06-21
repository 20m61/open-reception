import { NextResponse } from 'next/server';
import { listReceptionLogs } from '@/lib/mock-backend/reception-log-store';
import {
  assertCanRead,
  defaultAdminTenantId,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';

/**
 * GET /api/admin/receptions — 受付履歴一覧 (issue #19, #22)。
 * 来訪者 PII を含まない運用ログのみを返す。
 *
 * 認可（#91 inc2）: route 側で実 actor を解決し `requireActor` + `assertCanRead`
 * で最終認可を行う（フロントで隠した操作でも 403）。
 */
export async function GET(): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanRead(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  return NextResponse.json({ items: await listReceptionLogs() });
}
