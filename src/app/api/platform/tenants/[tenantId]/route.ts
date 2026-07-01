import { NextResponse } from 'next/server';
import { asTenantId, type Device, type Site, type Tenant } from '@/domain/tenant/types';
import { getTenantStore } from '@/lib/tenant/store';
import { summarizeTenantDetail } from '@/domain/platform/console-summary';
import {
  auditActionForLifecycle,
  isTenantLifecycleAction,
  statusForLifecycleAction,
} from '@/domain/platform/tenant-lifecycle';
import { authorizePlatform, assertElevated } from '@/lib/platform/request';
import { recordDangerAction } from '@/lib/admin/audit';
import { readJson } from '@/lib/data-stores/result-http';

/**
 * GET /api/platform/tenants/[tenantId] — テナント詳細（テナント横断 read） (issue #90, increment 2)。
 *
 * developer 専用の read-only API。テナントのメタ情報に加え、配下のサイト数・端末数・状態
 * （稼働中/メンテナンス表示中）を集計して返す。端末トークン等の機密や来訪者/担当者 PII は
 * 含めない。有効/停止・プラン/制限変更などの破壊的操作は本増分では提供しない（プレースホルダ維持）。
 *
 * 認可: authorizePlatform()（未認証 401 / 非 developer 403）。developer は全テナント横断 read。
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ tenantId: string }> },
): Promise<NextResponse> {
  const auth = await authorizePlatform();
  if (!auth.ok) return auth.response;

  const { tenantId: raw } = await params;
  const tenantId = asTenantId(raw);
  const store = getTenantStore();
  const tenant = await store.tenants.getTenant(tenantId);
  if (!tenant) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const sites: Site[] = await store.sites.listSites(tenantId);
  const sitesWithDevices: { site: Site; devices: Device[] }[] = [];
  for (const site of sites) {
    const devices = await store.devices.listDevices(tenantId, site.id);
    sitesWithDevices.push({ site, devices });
  }

  return NextResponse.json({ detail: summarizeTenantDetail(tenant, sitesWithDevices) });
}

/**
 * PATCH /api/platform/tenants/[tenantId] — テナントの有効化/停止 (issue #90)。
 *
 * developer 専用の破壊的操作。body は { action: 'suspend'|'activate', reason?: string }。
 * 確認・理由入力・影響範囲提示は UI（DangerActionButton）側で担保し、本ルートは最終認可・
 * 状態更新・監査（recordDangerAction で理由を残す）を行う。停止してもデータは保持する。
 *
 * 認可: authorizePlatform()（未認証 401 / 非 developer 403）。
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ tenantId: string }> },
): Promise<NextResponse> {
  const { tenantId: raw } = await params;
  // 破壊的操作（テナント停止/再開）は JIT 昇格必須 (#83 AC5/AC10)。当該テナントを覆う昇格が要る。
  const gate = await assertElevated({ tenantId: raw });
  if (!gate.ok) return gate.response;

  const body = (await readJson(request)) as { action?: unknown; reason?: unknown } | null;
  const action = body?.action;
  if (!isTenantLifecycleAction(action)) {
    return NextResponse.json({ error: 'invalid_input', message: 'action must be suspend|activate' }, { status: 400 });
  }

  const tenantId = asTenantId(raw);
  const store = getTenantStore();
  const tenant = await store.tenants.getTenant(tenantId);
  if (!tenant) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const next: Tenant = {
    ...tenant,
    status: statusForLifecycleAction(action),
    updatedAt: new Date().toISOString(),
  };
  await store.tenants.putTenant(next);

  const reason = typeof body?.reason === 'string' ? body.reason.trim() : undefined;
  await recordDangerAction({
    action: auditActionForLifecycle(action),
    target: { type: 'tenant', id: tenant.id },
    reason: reason || undefined,
    // 高詳細監査 (issue #83 AC13): status の before/after と操作元 IP/user-agent を残す。
    before: { status: tenant.status },
    after: { status: next.status },
    actor: `platform:${gate.elevation.sub}`, // 昇格した操作者を監査 actor に（#264）。
    request,
  });

  return NextResponse.json({
    tenant: { id: next.id, name: next.name, slug: next.slug, status: next.status, updatedAt: next.updatedAt },
  });
}
