import { NextResponse } from 'next/server';
import { importDepartments } from '@/lib/data-stores/directory-store';
import { parseCsvRecords } from '@/lib/csv/parse';
import { readJson } from '@/lib/data-stores/result-http';
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import {
  assertCanWrite,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';
import { resolveAdminTenantId } from '@/lib/tenant/admin-tenant-scope';
import { asTenantId } from '@/domain/tenant/types';

/**
 * POST /api/admin/departments/import — 部署 CSV の取り込み (issue #25)。
 * body: { csv: string, mode: 'preview' | 'apply' }。preview は差分件数のみ返し変更しない。
 *
 * 認可（#91 inc2）: preview も含め書込権を要求する（CSV 内容の読込・差分計算は write 操作の前段）。
 * `requireActor` + `assertCanWrite`（viewer は 403）。
 */
export async function POST(request: Request): Promise<NextResponse> {
  let tenantId: string;
  try {
    const actor = await requireActor();
    tenantId = await resolveAdminTenantId();
    assertCanWrite(actor, asTenantId(tenantId));
  } catch (err) {
    return toGuardResponse(err);
  }
  const body = (await readJson(request)) as { csv?: unknown; mode?: unknown } | null;
  if (!body || typeof body.csv !== 'string') {
    return NextResponse.json({ error: 'invalid_input', message: 'csv is required' }, { status: 400 });
  }
  const mode = body.mode === 'apply' ? 'apply' : 'preview';
  const { records } = parseCsvRecords(body.csv);
  const summary = await importDepartments(tenantId, records, mode);
  if (mode === 'apply') {
    await appendAdminAudit('department.created', { type: 'department' }, {
      via: 'csv',
      created: String(summary.created),
      updated: String(summary.updated),
    });
  }
  return NextResponse.json(summary);
}
