import { NextResponse } from 'next/server';
import { getMotionMapping, setDefaultMotion, setMotion } from '@/lib/motion/motion-store';
import { listAssets } from '@/lib/assets/asset-store';
import { readJson, resultResponse } from '@/lib/mock-backend/result-http';
import { appendAdminAudit } from '@/lib/mock-backend/reception-log-store';

/**
 * GET /api/admin/motions — 状態別モーション割り当て + 選択可能なモーションアセット (issue #31)。
 * PUT /api/admin/motions — 割り当ての更新。body: { key, assetId } または { default: assetId }（null で解除）。
 */
export function GET(): NextResponse {
  return NextResponse.json({ ...getMotionMapping(), assets: listAssets('motion') });
}

export async function PUT(request: Request): Promise<NextResponse> {
  const body = (await readJson(request)) as { key?: unknown; assetId?: unknown; default?: unknown } | null;
  if (body && 'default' in body) {
    const assetId = typeof body.default === 'string' ? body.default : null;
    const r = setDefaultMotion(assetId);
    if (r.ok) appendAdminAudit('motion.updated', { type: 'motion', id: 'default' });
    return r.ok ? NextResponse.json(getMotionMapping()) : resultResponse(r);
  }
  if (body && typeof body.key === 'string') {
    const assetId = typeof body.assetId === 'string' ? body.assetId : null;
    const r = setMotion(body.key, assetId);
    if (r.ok) appendAdminAudit('motion.updated', { type: 'motion', id: body.key });
    return r.ok ? NextResponse.json(getMotionMapping()) : resultResponse(r);
  }
  return NextResponse.json({ error: 'invalid_input', message: 'key or default required' }, { status: 400 });
}
