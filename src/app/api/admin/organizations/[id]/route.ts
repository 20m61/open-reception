import { NextResponse } from 'next/server';
import {
  assertCanWrite,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import { readJson } from '@/lib/data-stores/result-http';
import { updateOrganizationUnit } from '@/lib/organization/organization-service';
import { resolveAdminTenantId } from '@/lib/tenant/admin-tenant-scope';
import { asTenantId } from '@/domain/tenant/types';

/**
 * PATCH /api/admin/organizations/[id] — 組織の編集 (#373 増分 5)。
 *
 * 編集できるのは公開表示名・表示順・来訪者への公開可否。`parentId`（階層）は循環検証を
 * 伴うため別増分で、未知のキーは**黙って無視せず 400** にする（送ったのに効かない方が危険）。
 *
 * 対象テナントはサーバ側の認可済みコンテキスト（`resolveAdminTenantId`）から導出し、
 * リクエスト由来の値を使わない（越境参照を組ませない）。scope 外の id は `not_found` に
 * 落ちるので、他テナント組織の実在は漏れない。
 */
export async function PATCH(
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

  const { id } = await context.params;
  const result = await updateOrganizationUnit(
    { kind: 'tenant', tenantId },
    id,
    await readJson(request),
  );
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error.code, message: result.error.message },
      { status: result.error.code === 'not_found' ? 404 : 400 },
    );
  }

  // 監査に残すのは「誰が・どの組織を編集したか」まで。表示名などの値は残さない
  // （運用に必要な最小情報。rules/pii-secret-minimization.md）。
  await appendAdminAudit('organization.updated', { type: 'organization', id });
  return NextResponse.json(result.value);
}
