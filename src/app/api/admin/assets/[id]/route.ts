import { NextResponse } from 'next/server';
import { setActiveAsset, setAssetEnabled } from '@/lib/assets/asset-store';
import { readJson, resultResponse } from '@/lib/mock-backend/result-http';
import { appendAdminAudit } from '@/lib/mock-backend/reception-log-store';

/**
 * PATCH /api/admin/assets/:id — アセットの有効/無効・アクティブ設定 (issue #27)。
 * body: { enabled?: boolean, active?: true }
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const body = (await readJson(request)) as { enabled?: unknown; active?: unknown } | null;

  if (body && typeof body.enabled === 'boolean') {
    const r = await setAssetEnabled(id, body.enabled);
    if (r.ok) await appendAdminAudit('asset.updated', { type: 'asset', id }, { enabled: String(body.enabled) });
    return resultResponse(r);
  }
  if (body && body.active === true) {
    const r = await setActiveAsset(id);
    if (r.ok) await appendAdminAudit('asset.updated', { type: 'asset', id }, { active: 'true' });
    return resultResponse(r);
  }
  return NextResponse.json({ error: 'invalid_input', message: 'enabled or active required' }, { status: 400 });
}
