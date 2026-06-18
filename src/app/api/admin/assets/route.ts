import { NextResponse } from 'next/server';
import { createAsset, getActiveAssets, listAssets } from '@/lib/assets/asset-store';
import { readJson, resultResponse } from '@/lib/mock-backend/result-http';
import { appendAdminAudit } from '@/lib/mock-backend/reception-log-store';

/**
 * GET /api/admin/assets — アセット一覧 + アクティブセット (issue #27)。
 * POST /api/admin/assets — アセット登録（種別・名称・URL・サイズを検証）。
 */
export function GET(): NextResponse {
  return NextResponse.json({ items: listAssets(), active: getActiveAssets() });
}

export async function POST(request: Request): Promise<NextResponse> {
  const result = createAsset(await readJson(request));
  if (result.ok) appendAdminAudit('asset.created', { type: 'asset', id: result.value.id }, { kind: result.value.kind });
  return resultResponse(result, 201);
}
