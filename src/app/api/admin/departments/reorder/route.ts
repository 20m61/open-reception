import { NextResponse } from 'next/server';
import { reorderDepartments } from '@/lib/mock-backend/directory-store';
import { readJson, resultResponse } from '@/lib/mock-backend/result-http';
import { appendAdminAudit } from '@/lib/mock-backend/reception-log-store';

/**
 * POST /api/admin/departments/reorder — DnD 並び替えの確定 (issue #25)。
 * body: { orderedIds: string[] }（先頭から順に displayOrder を割り当てる）
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body = (await readJson(request)) as { orderedIds?: unknown } | null;
  const result = reorderDepartments(body?.orderedIds);
  if (result.ok) appendAdminAudit('department.reordered', { type: 'department' }, { via: 'dnd' });
  return resultResponse(result);
}
