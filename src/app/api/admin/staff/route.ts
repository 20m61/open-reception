import { NextResponse } from 'next/server';
import { createStaff, listStaff } from '@/lib/mock-backend/directory-store';
import { readJson, resultResponse } from '@/lib/mock-backend/result-http';
import { appendAdminAudit } from '@/lib/mock-backend/reception-log-store';

/**
 * GET /api/admin/staff — 担当者一覧（無効含む） (issue #3, #26)。
 * POST /api/admin/staff — 担当者作成。
 *
 * NOTE: 認証・認可は #24 で middleware により付与する。
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ items: await listStaff(true) });
}

export async function POST(request: Request): Promise<NextResponse> {
  const result = await createStaff(await readJson(request));
  if (result.ok) await appendAdminAudit('staff.created', { type: 'staff', id: result.value.id });
  return resultResponse(result, 201);
}
