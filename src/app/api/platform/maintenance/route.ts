import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import type { Device } from '@/domain/tenant/types';
import { getTenantStore } from '@/lib/tenant/store';
import { summarizeMaintenance } from '@/domain/platform/console-summary';
import { summarizeIncidents } from '@/domain/platform/incident';
import { listIncidents } from '@/lib/platform/incident-store';
import { summarizeMaintenanceWindows } from '@/domain/platform/maintenance-window';
import { listMaintenanceWindows } from '@/lib/platform/maintenance-window-store';
import { filterToSelectedTenant } from '@/domain/platform/tenant-scope';
import { SELECTED_TENANT_COOKIE } from '@/lib/platform/selected-tenant';
import { authorizePlatform } from '@/lib/platform/request';

/**
 * GET /api/platform/maintenance — メンテナンス状況・障害情報の read (issue #90, increment 2/3e)。
 *
 * developer 専用の read-only API。
 *   - メンテナンス表示中（受付を止め保守メッセージを出している）の端末を横断集計（inc2）。
 *   - 障害・インシデント（Incident）の横断集計（inc3e）。進行中優先・重大度降順で並べ、
 *     進行中件数と重大度内訳を返す。来訪者/担当者 PII・操作者識別子は含めない（射影 whitelist）。
 *   - 予定メンテナンス（MaintenanceWindow）の横断集計（inc3e）。進行/予定を優先し開始予定の
 *     早い順で並べ、進行中/予定件数を返す。操作者識別子は含めない（射影 whitelist）。
 *
 * 対象テナント選択（inc3b-2）: Cookie（or_platform_tenant）で対象テナントが選ばれている場合、
 * 障害・予定メンテナンスを「全体影響（scope=platform）か選択テナント」に絞る。端末の
 * メンテナンス集計は端末がテナント横断のため本増分では絞らない（全体把握を優先）。
 *
 * 機密値・来訪者/担当者 PII は含めない（端末名は運用メモであり PII ではない）。
 * 未接続（次増分）: お知らせ（notices）。
 *
 * メンテナンスモード発動・障害登録などの破壊的操作は本 API では提供せず、画面側で影響範囲表示・
 * 昇格・監査を伴う導線（DangerActionPlaceholder）に隔離する。
 *
 * 認可: authorizePlatform()（未認証 401 / 非 developer 403）。
 */
export async function GET(): Promise<NextResponse> {
  const auth = await authorizePlatform();
  if (!auth.ok) return auth.response;

  const store = getTenantStore();
  const tenants = await store.tenants.listTenants();
  const entries: { tenant: (typeof tenants)[number]; devices: Device[] }[] = [];
  for (const tenant of tenants) {
    const sites = await store.sites.listSites(tenant.id);
    const devices: Device[] = [];
    for (const site of sites) {
      devices.push(...(await store.devices.listDevices(tenant.id, site.id)));
    }
    entries.push({ tenant, devices });
  }

  const selectedTenantId = (await cookies()).get(SELECTED_TENANT_COOKIE)?.value || null;
  const incidents = summarizeIncidents(
    filterToSelectedTenant(await listIncidents(), selectedTenantId),
  );
  const windows = summarizeMaintenanceWindows(
    filterToSelectedTenant(await listMaintenanceWindows(), selectedTenantId),
  );
  const pending = { status: 'pending' as const };
  return NextResponse.json({
    summary: summarizeMaintenance(entries),
    incidents,
    windows,
    notices: pending,
  });
}
