import { NextResponse } from 'next/server';
import { moveDepartment } from '@/lib/mock-backend/directory-store';
import { readJson, resultResponse } from '@/lib/mock-backend/result-http';
import { appendAdminAudit } from '@/lib/mock-backend/reception-log-store';

/**
 * POST /api/admin/departments/:id/move — 部署の表示順を1つ上/下へ移動 (issue #25)。
 * body: { direction: 'up' | 'down' }
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const body = (await readJson(request)) as { direction?: unknown } | null;
  const direction = body?.direction;
  if (direction !== 'up' && direction !== 'down') {
    return NextResponse.json({ error: 'invalid_input', message: 'direction must be up or down' }, { status: 400 });
  }
  const result = await moveDepartment(id, direction);
  if (result.ok) await appendAdminAudit('department.reordered', { type: 'department', id }, { direction });
  return resultResponse(result);
}
