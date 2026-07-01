import { NextResponse } from 'next/server';
import { readJson } from '@/lib/data-stores/result-http';
import type { DeviceKind } from '@/domain/tenant/types';
import { getDeviceService } from '@/lib/tenant/store';
import {
  readSiteScope,
  readTenantScope,
  resolveAdminActor,
  serviceResponse,
} from '@/lib/tenant/request';

/**
 * GET  /api/admin/devices?tenantId=&siteId= — サイト配下の受付端末一覧 (issue #87 inc2)。
 * POST /api/admin/devices                    — 受付端末を登録する。
 *
 * 認証: 管理セッション必須（無効なら 401）。
 * 認可: #80 の canAccessSite 純関数で tenant/site 境界を判定する（service 層）。
 * セキュリティ: device token の平文は返却しない（tokenRegistered の真偽のみ）。
 */
const KINDS: readonly DeviceKind[] = ['kiosk', 'tablet', 'desktop'];
function parseKind(v: unknown): DeviceKind | undefined {
  return typeof v === 'string' && (KINDS as readonly string[]).includes(v)
    ? (v as DeviceKind)
    : undefined;
}

export async function GET(request: Request): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const tenant = readTenantScope(params);
  if (!tenant.ok) return NextResponse.json(tenant.error, { status: 400 });
  const site = readSiteScope(params);
  if (!site.ok) return NextResponse.json(site.error, { status: 400 });
  const result = await getDeviceService().list(actor, tenant.tenantId, site.siteId);
  return serviceResponse(result);
}

export async function POST(request: Request): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = (await readJson(request)) as Record<string, unknown> | null;
  const tenant = readTenantScope(body ?? {});
  if (!tenant.ok) return NextResponse.json(tenant.error, { status: 400 });
  const site = readSiteScope(body ?? {});
  if (!site.ok) return NextResponse.json(site.error, { status: 400 });
  const name = typeof body?.name === 'string' ? body.name : '';
  const location = typeof body?.location === 'string' ? body.location : undefined;
  const result = await getDeviceService().create(actor, {
    tenantId: tenant.tenantId,
    siteId: site.siteId,
    name,
    location,
    kind: parseKind(body?.kind),
  });
  return serviceResponse(result, 201);
}
