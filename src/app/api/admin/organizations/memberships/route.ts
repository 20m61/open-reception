import { NextResponse } from 'next/server';
import { assertCanRead, requireActor, toGuardResponse } from '@/lib/admin/guard';
import { getOrganizationView } from '@/lib/organization/organization-service';
import { resolveAdminTenantId } from '@/lib/tenant/admin-tenant-scope';
import { asTenantId } from '@/domain/tenant/types';

/**
 * GET /api/admin/organizations/memberships — 所属一覧 (#373 増分 8)。
 *
 * 返すのは**合成ビュー**（`staff.departmentId` 由来の主所属 + 保存済みの兼務）。片方だけを
 * 返すと「担当者管理に出ているのに所属一覧に無い」という食い違いになる。
 *
 * 管理向けなので `callable` / `publicInDirectory` も含む。来訪者向けの経路とは別であり、
 * この応答を kiosk へ流用しないこと。
 */
export async function GET(): Promise<NextResponse> {
  let tenantId: string;
  try {
    const actor = await requireActor();
    tenantId = await resolveAdminTenantId();
    assertCanRead(actor, asTenantId(tenantId));
  } catch (err) {
    return toGuardResponse(err);
  }
  const view = await getOrganizationView({ kind: 'tenant', tenantId });
  return NextResponse.json({ items: view.memberships });
}
