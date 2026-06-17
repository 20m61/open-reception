import type { NextResponse } from 'next/server';
import { updateStaff } from '@/lib/mock-backend/directory-store';
import { readJson, resultResponse } from '@/lib/mock-backend/result-http';
import { appendAdminAudit } from '@/lib/mock-backend/reception-log-store';

/**
 * PATCH /api/admin/staff/:id — 担当者更新（名称・部署・有効/無効・在席） (issue #26)。
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const result = updateStaff(id, await readJson(request));
  if (result.ok) appendAdminAudit('staff.updated', { type: 'staff', id });
  return resultResponse(result);
}
