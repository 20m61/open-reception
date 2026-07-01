import { NextResponse } from 'next/server';
import { updateStaff } from '@/lib/data-stores/directory-store';
import { readJson, resultResponse } from '@/lib/data-stores/result-http';
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import {
  assertCanWrite,
  defaultAdminTenantId,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';

/**
 * PATCH /api/admin/staff/:id — 担当者更新（名称・部署・有効/無効・在席） (issue #26)。
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
  const result = await updateStaff(id, await readJson(request));
  if (result.ok) await appendAdminAudit('staff.updated', { type: 'staff', id });
  return resultResponse(result);
}
