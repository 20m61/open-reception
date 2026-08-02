import { NextResponse } from 'next/server';
import { assertCanWrite, requireActor, toGuardResponse } from '@/lib/admin/guard';
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import { readJson } from '@/lib/data-stores/result-http';
import {
  addSecondaryMembership,
  removeSecondaryMembership,
} from '@/lib/organization/organization-service';
import { resolveAdminTenantId } from '@/lib/tenant/admin-tenant-scope';
import { asTenantId } from '@/domain/tenant/types';

/**
 * POST/DELETE /api/admin/staff/[id]/memberships — 担当者の兼務 (#373 増分 8)。
 *
 * 主所属は `staff.departmentId`（既存の担当者管理）が真実源なので、ここでは**兼務だけ**を
 * 足し引きする。主所属と同じ組織を渡されたら 400。
 *
 * 対象テナントはサーバ側の認可済みコンテキスト（`resolveAdminTenantId`）から導出し、
 * リクエスト由来の値を使わない。scope 外の組織 id は `not_found` に落ちる。
 */
async function readTarget(
  request: Request,
): Promise<{ organizationId: string } | { error: NextResponse }> {
  const body = (await readJson(request)) as Record<string, unknown> | null;
  const organizationId = body?.organizationId;
  if (typeof organizationId !== 'string' || organizationId.trim() === '') {
    return {
      error: NextResponse.json(
        { error: 'invalid_input', message: 'organizationId is required' },
        { status: 400 },
      ),
    };
  }
  return { organizationId: organizationId.trim() };
}

function toResponse(result: { ok: boolean; error?: { code: string; message: string } }) {
  if (result.ok) return NextResponse.json({ ok: true });
  return NextResponse.json(
    { error: result.error?.code, message: result.error?.message },
    { status: result.error?.code === 'not_found' ? 404 : 400 },
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  let tenantId: string;
  try {
    const actor = await requireActor();
    tenantId = await resolveAdminTenantId();
    assertCanWrite(actor, asTenantId(tenantId));
  } catch (err) {
    return toGuardResponse(err);
  }
  const target = await readTarget(request);
  if ('error' in target) return target.error;
  const { id } = await context.params;
  const result = await addSecondaryMembership(
    { kind: 'tenant', tenantId },
    id,
    target.organizationId,
  );
  // 監査に残すのは「誰が・どの担当者の所属を変えたか」まで（値は残さない）。
  if (result.ok) await appendAdminAudit('staff.updated', { type: 'staff', id });
  return toResponse(result);
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  let tenantId: string;
  try {
    const actor = await requireActor();
    tenantId = await resolveAdminTenantId();
    assertCanWrite(actor, asTenantId(tenantId));
  } catch (err) {
    return toGuardResponse(err);
  }
  const target = await readTarget(request);
  if ('error' in target) return target.error;
  const { id } = await context.params;
  const result = await removeSecondaryMembership(
    { kind: 'tenant', tenantId },
    id,
    target.organizationId,
  );
  if (result.ok) await appendAdminAudit('staff.updated', { type: 'staff', id });
  return toResponse(result);
}
