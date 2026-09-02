import { NextResponse } from 'next/server';
import { createAsset, getActiveAssets, listAssets } from '@/lib/assets/asset-store';
import { readJson, resultResponse } from '@/lib/data-stores/result-http';
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import {
  assertCanRead,
  assertCanWrite,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';
import { resolveAdminTenantId } from '@/lib/tenant/admin-tenant-scope';
import { asTenantId } from '@/domain/tenant/types';

/**
 * GET /api/admin/assets — アセット一覧 + アクティブセット (issue #27)。
 * POST /api/admin/assets — アセット登録（種別・名称・URL・サイズを検証）。
 *
 * 認可（#91 inc2）: route 側で実 actor を解決し `requireActor` + `assertCanRead/Write`
 * で最終認可を行う（フロントで隠した操作でも 403）。
 */
export async function GET(): Promise<NextResponse> {
  let tenantId: string;
  try {
    const actor = await requireActor();
    tenantId = await resolveAdminTenantId();
    assertCanRead(actor, asTenantId(tenantId));
  } catch (err) {
    return toGuardResponse(err);
  }
  return NextResponse.json({ items: await listAssets(tenantId), active: await getActiveAssets(tenantId) });
}

export async function POST(request: Request): Promise<NextResponse> {
  let tenantId: string;
  try {
    const actor = await requireActor();
    tenantId = await resolveAdminTenantId();
    assertCanWrite(actor, asTenantId(tenantId));
  } catch (err) {
    return toGuardResponse(err);
  }
  const result = await createAsset(tenantId, await readJson(request));
  if (result.ok) await appendAdminAudit('asset.created', { type: 'asset', id: result.value.id }, { kind: result.value.kind });
  return resultResponse(result, 201);
}
