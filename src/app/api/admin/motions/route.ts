import { NextResponse } from 'next/server';
import { getMotionMapping, setDefaultMotion, setMotion } from '@/lib/motion/motion-store';
import { listAssets } from '@/lib/assets/asset-store';
import { readJson, resultResponse } from '@/lib/data-stores/result-http';
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import { assertCanRead, assertCanWrite, requireActor, toGuardResponse } from '@/lib/admin/guard';
import { resolveAdminTenantId } from '@/lib/tenant/admin-tenant-scope';
import { asTenantId } from '@/domain/tenant/types';

/**
 * GET /api/admin/motions — 状態別モーション割り当て + 選択可能なモーションアセット (issue #31)。
 * PUT /api/admin/motions — 割り当ての更新。body: { key, assetId } または { default: assetId }（null で解除）。
 *
 * 認可（#91 inc2）: route 側で実 actor を解決し `requireActor` + `assertCanRead/Write`
 * で最終認可を行う（フロントで隠した操作でも 403）。
 *
 * **対象テナントは選択中テナント** (#419 残増分)。以前は `defaultAdminTenantId()` 固定だった。
 * 対象はサーバ側の認可済みコンテキストから導出し、body/query の値は使わない。
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
  return NextResponse.json({
    ...(await getMotionMapping(tenantId)),
    assets: await listAssets(tenantId, 'motion'),
  });
}

export async function PUT(request: Request): Promise<NextResponse> {
  let tenantId: string;
  try {
    const actor = await requireActor();
    tenantId = await resolveAdminTenantId();
    assertCanWrite(actor, asTenantId(tenantId));
  } catch (err) {
    return toGuardResponse(err);
  }
  const body = (await readJson(request)) as { key?: unknown; assetId?: unknown; default?: unknown } | null;
  if (body && 'default' in body) {
    const assetId = typeof body.default === 'string' ? body.default : null;
    const r = await setDefaultMotion(tenantId, assetId);
    if (r.ok) await appendAdminAudit('motion.updated', { type: 'motion', id: 'default' });
    return r.ok ? NextResponse.json(await getMotionMapping(tenantId)) : resultResponse(r);
  }
  if (body && typeof body.key === 'string') {
    const assetId = typeof body.assetId === 'string' ? body.assetId : null;
    const r = await setMotion(tenantId, body.key, assetId);
    if (r.ok) await appendAdminAudit('motion.updated', { type: 'motion', id: body.key });
    return r.ok ? NextResponse.json(await getMotionMapping(tenantId)) : resultResponse(r);
  }
  return NextResponse.json({ error: 'invalid_input', message: 'key or default required' }, { status: 400 });
}
