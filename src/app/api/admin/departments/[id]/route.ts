import type { NextResponse } from 'next/server';
import { updateDepartment } from '@/lib/mock-backend/directory-store';
import { readJson, resultResponse } from '@/lib/mock-backend/result-http';

/**
 * PATCH /api/admin/departments/:id — 部署更新（名称・有効/無効・表示順） (issue #25)。
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  return resultResponse(updateDepartment(id, await readJson(request)));
}
