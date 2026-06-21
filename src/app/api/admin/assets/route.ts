import { NextResponse } from 'next/server';
import { createAsset, getActiveAssets, listAssets } from '@/lib/assets/asset-store';
import { readJson, resultResponse } from '@/lib/mock-backend/result-http';
import { appendAdminAudit } from '@/lib/mock-backend/reception-log-store';
import {
  assertCanRead,
  assertCanWrite,
  defaultAdminTenantId,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';

/**
 * GET /api/admin/assets — アセット一覧 + アクティブセット (issue #27)。
 * POST /api/admin/assets — アセット登録（種別・名称・URL・サイズを検証）。
 *
 * 認可（#91 inc2）: route 側で実 actor を解決し `requireActor` + `assertCanRead/Write`
 * で最終認可を行う（フロントで隠した操作でも 403）。
 */
export async function GET(): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanRead(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  return NextResponse.json({ items: await listAssets(), active: await getActiveAssets() });
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanWrite(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  const result = await createAsset(await readJson(request));
  if (result.ok) await appendAdminAudit('asset.created', { type: 'asset', id: result.value.id }, { kind: result.value.kind });
  return resultResponse(result, 201);
}
