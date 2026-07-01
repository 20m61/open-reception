import { NextResponse } from 'next/server';
import { createDepartment, listDepartments } from '@/lib/data-stores/directory-store';
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
 * GET /api/admin/departments — 部署一覧（無効含む） (issue #3, #25)。
 * POST /api/admin/departments — 部署作成。
 *
 * 認可（#91 inc2）: middleware の入口ガードに加え、route 側で実 actor を解決し
 * `requireActor` + `assertCanRead/Write` で **最終認可** を行う（フロントで隠した操作でも 403）。
 */
export async function GET(): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanRead(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  return NextResponse.json({ items: await listDepartments(true) });
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanWrite(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  const result = await createDepartment(await readJson(request));
  if (result.ok) await appendAdminAudit('department.created', { type: 'department', id: result.value.id });
  return resultResponse(result, 201);
}
