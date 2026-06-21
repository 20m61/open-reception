import { NextResponse } from 'next/server';
import { asTenantId, type Device, type Site } from '@/domain/tenant/types';
import { getTenantStore } from '@/lib/tenant/store';
import { summarizeTenantDetail } from '@/domain/platform/console-summary';
import { authorizePlatform } from '@/lib/platform/request';

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
