import { NextResponse } from 'next/server';
import { createAsset, getActiveAssets, listAssets } from '@/lib/assets/asset-store';
import { readJson, resultResponse } from '@/lib/mock-backend/result-http';
import { appendAdminAudit } from '@/lib/mock-backend/reception-log-store';

/**
 * GET /api/admin/assets — アセット一覧 + アクティブセット (issue #27)。
 * POST /api/admin/assets — アセット登録（種別・名称・URL・サイズを検証）。
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ items: await listAssets(), active: await getActiveAssets() });
}

export async function POST(request: Request): Promise<NextResponse> {
  const result = await createAsset(await readJson(request));
  if (result.ok) await appendAdminAudit('asset.created', { type: 'asset', id: result.value.id }, { kind: result.value.kind });
  return resultResponse(result, 201);
}
