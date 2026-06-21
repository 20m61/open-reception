import { NextResponse } from 'next/server';
import { updateDepartment } from '@/lib/mock-backend/directory-store';
import { readJson, resultResponse } from '@/lib/mock-backend/result-http';
import { appendAdminAudit } from '@/lib/mock-backend/reception-log-store';
import {
  assertCanWrite,
  defaultAdminTenantId,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';

/**
 * PATCH /api/admin/departments/:id — 部署更新（名称・有効/無効・表示順） (issue #25)。
 *
 * 認可（#91 inc2）: `requireActor` + `assertCanWrite` で最終認可（viewer は 403）。
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanWrite(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  const { id } = await params;
  const result = await updateDepartment(id, await readJson(request));
  if (result.ok) await appendAdminAudit('department.updated', { type: 'department', id });
  return resultResponse(result);
}
