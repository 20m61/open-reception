import { NextResponse } from 'next/server';
import { importDepartments } from '@/lib/mock-backend/directory-store';
import { parseCsvRecords } from '@/lib/csv/parse';
import { readJson } from '@/lib/mock-backend/result-http';
import { appendAdminAudit } from '@/lib/mock-backend/reception-log-store';

/**
 * POST /api/admin/departments/import — 部署 CSV の取り込み (issue #25)。
 * body: { csv: string, mode: 'preview' | 'apply' }。preview は差分件数のみ返し変更しない。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body = (await readJson(request)) as { csv?: unknown; mode?: unknown } | null;
  if (!body || typeof body.csv !== 'string') {
    return NextResponse.json({ error: 'invalid_input', message: 'csv is required' }, { status: 400 });
  }
  const mode = body.mode === 'apply' ? 'apply' : 'preview';
  const { records } = parseCsvRecords(body.csv);
  const summary = importDepartments(records, mode);
  if (mode === 'apply') {
    appendAdminAudit('department.created', { type: 'department' }, {
      via: 'csv',
      created: String(summary.created),
      updated: String(summary.updated),
    });
  }
  return NextResponse.json(summary);
}
