import { NextResponse } from 'next/server';
import { importStaff } from '@/lib/mock-backend/directory-store';
import { parseCsvRecords } from '@/lib/csv/parse';
import { readJson } from '@/lib/mock-backend/result-http';
import { appendAdminAudit } from '@/lib/mock-backend/reception-log-store';

/**
 * POST /api/admin/staff/import — 担当者 CSV の取り込み (issue #26)。
 * body: { csv: string, mode: 'preview' | 'apply' }。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body = (await readJson(request)) as { csv?: unknown; mode?: unknown } | null;
  if (!body || typeof body.csv !== 'string') {
    return NextResponse.json({ error: 'invalid_input', message: 'csv is required' }, { status: 400 });
  }
  const mode = body.mode === 'apply' ? 'apply' : 'preview';
  const { records } = parseCsvRecords(body.csv);
  const summary = importStaff(records, mode);
  if (mode === 'apply') {
    appendAdminAudit('staff.created', { type: 'staff' }, {
      via: 'csv',
      created: String(summary.created),
      updated: String(summary.updated),
    });
  }
  return NextResponse.json(summary);
}
