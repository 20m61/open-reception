import { NextResponse } from 'next/server';
import { updateDepartment } from '@/lib/data-stores/directory-store';
import { readJson, resultResponse } from '@/lib/data-stores/result-http';
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import {
  assertCanWrite,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';
import { resolveAdminTenantId } from '@/lib/tenant/admin-tenant-scope';
import { asTenantId } from '@/domain/tenant/types';

/**
 * PATCH /api/admin/departments/:id — 部署更新（名称・有効/無効・表示順） (issue #25)。
 *
 * 認可（#91 inc2）: `requireActor` + `assertCanWrite` で最終認可（viewer は 403）。
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  let tenantId: string;
  try {
    const actor = await requireActor();
    tenantId = await resolveAdminTenantId();
    assertCanWrite(actor, asTenantId(tenantId));
  } catch (err) {
    return toGuardResponse(err);
  }
  const { id } = await params;
  const result = await updateDepartment(tenantId, id, await readJson(request));
  if (result.ok) await appendAdminAudit('department.updated', { type: 'department', id });
  return resultResponse(result);
}
