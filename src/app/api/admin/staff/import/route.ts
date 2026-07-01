import { NextResponse } from 'next/server';
import { importStaff } from '@/lib/data-stores/directory-store';
import { parseCsvRecords } from '@/lib/csv/parse';
import { readJson } from '@/lib/data-stores/result-http';
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import {
  assertCanWrite,
  defaultAdminTenantId,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';

/**
 * POST /api/admin/staff/import — 担当者 CSV の取り込み (issue #26)。
 * body: { csv: string, mode: 'preview' | 'apply' }。
 *
 * 認可（#91 inc2）: preview も含め書込権を要求する。`requireActor` + `assertCanWrite`（viewer は 403）。
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanWrite(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  const body = (await readJson(request)) as { csv?: unknown; mode?: unknown } | null;
  if (!body || typeof body.csv !== 'string') {
    return NextResponse.json({ error: 'invalid_input', message: 'csv is required' }, { status: 400 });
  }
  const mode = body.mode === 'apply' ? 'apply' : 'preview';
  const { records } = parseCsvRecords(body.csv);
  const summary = await importStaff(records, mode);
  if (mode === 'apply') {
    await appendAdminAudit('staff.created', { type: 'staff' }, {
      via: 'csv',
      created: String(summary.created),
      updated: String(summary.updated),
    });
  }
  return NextResponse.json(summary);
}
