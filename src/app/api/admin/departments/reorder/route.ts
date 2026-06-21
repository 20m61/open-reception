import { NextResponse } from 'next/server';
import { reorderDepartments } from '@/lib/mock-backend/directory-store';
import { readJson, resultResponse } from '@/lib/mock-backend/result-http';
import { appendAdminAudit } from '@/lib/mock-backend/reception-log-store';
import {
  assertCanWrite,
  defaultAdminTenantId,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';

/**
 * POST /api/admin/departments/reorder — DnD 並び替えの確定 (issue #25)。
 * body: { orderedIds: string[] }（先頭から順に displayOrder を割り当てる）
 *
 * 認可（#91 inc2）: `requireActor` + `assertCanWrite` で最終認可（viewer は 403）。
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanWrite(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  const body = (await readJson(request)) as { orderedIds?: unknown } | null;
  const result = await reorderDepartments(body?.orderedIds);
  if (result.ok) await appendAdminAudit('department.reordered', { type: 'department' }, { via: 'dnd' });
  return resultResponse(result);
}
