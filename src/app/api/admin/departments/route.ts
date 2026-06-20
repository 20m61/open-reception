import { NextResponse } from 'next/server';
import { createDepartment, listDepartments } from '@/lib/mock-backend/directory-store';
import { readJson, resultResponse } from '@/lib/mock-backend/result-http';
import { appendAdminAudit } from '@/lib/mock-backend/reception-log-store';

/**
 * GET /api/admin/departments — 部署一覧（無効含む） (issue #3, #25)。
 * POST /api/admin/departments — 部署作成。
 *
 * NOTE: 認証・認可は #24 で middleware により付与する。
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ items: await listDepartments(true) });
}

export async function POST(request: Request): Promise<NextResponse> {
  const result = await createDepartment(await readJson(request));
  if (result.ok) await appendAdminAudit('department.created', { type: 'department', id: result.value.id });
  return resultResponse(result, 201);
}
