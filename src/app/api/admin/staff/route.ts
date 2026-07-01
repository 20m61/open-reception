import { NextResponse } from 'next/server';
import { createStaff, listStaff } from '@/lib/data-stores/directory-store';
import { readJson, resultResponse } from '@/lib/data-stores/result-http';
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import {
  assertCanRead,
  assertCanWrite,
  defaultAdminTenantId,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';

/**
 * GET /api/admin/staff — 担当者一覧（無効含む） (issue #3, #26)。
 * POST /api/admin/staff — 担当者作成。
 *
 * 認可（#91 inc2）: route 側で実 actor を解決し `requireActor` + `assertCanRead/Write`
 * で最終認可を行う（フロントで隠した操作でも 403）。
 */
export async function GET(): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanRead(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  return NextResponse.json({ items: await listStaff(true) });
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanWrite(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  const result = await createStaff(await readJson(request));
  if (result.ok) await appendAdminAudit('staff.created', { type: 'staff', id: result.value.id });
  return resultResponse(result, 201);
}
