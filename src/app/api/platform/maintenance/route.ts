import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import type { Device } from '@/domain/tenant/types';
import { getTenantStore } from '@/lib/tenant/store';
import { summarizeMaintenance } from '@/domain/platform/console-summary';
import { summarizeIncidents } from '@/domain/platform/incident';
import { listIncidents } from '@/lib/platform/incident-store';
import { randomUUID } from 'node:crypto';
import {
  summarizeMaintenanceWindows,
  buildMaintenanceWindow,
  type MaintenanceWindowInput,
} from '@/domain/platform/maintenance-window';
import { listMaintenanceWindows, createMaintenanceWindow } from '@/lib/platform/maintenance-window-store';
import { recordDangerAction } from '@/lib/admin/audit';
import { assertElevated } from '@/lib/platform/request';
import { summarizeNotices } from '@/domain/platform/notice';
import { listNotices } from '@/lib/platform/notice-store';
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
 *   - お知らせ（Notice）の横断集計（inc3e）。掲示中を優先し重要度降順・公開新しい順で並べ、
 *     掲示中件数を返す。操作者識別子は含めない（射影 whitelist）。
 *
 * 対象テナント選択（inc3b-2）: Cookie（or_platform_tenant）で対象テナントが選ばれている場合、
 * 障害・予定メンテナンス・お知らせを「全体影響（scope=platform）か選択テナント」に絞る。端末の
 * メンテナンス集計は端末がテナント横断のため本増分では絞らない（全体把握を優先）。
 *
 * 機密値・来訪者/担当者 PII は含めない（端末名は運用メモであり PII ではない）。
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
  const notices = summarizeNotices(filterToSelectedTenant(await listNotices(), selectedTenantId));
  return NextResponse.json({
    summary: summarizeMaintenance(entries),
    incidents,
    windows,
    notices,
  });
}

/**
 * POST /api/platform/maintenance — メンテナンスウィンドウの登録 (issue #83 メンテナンス管理 / inc4c)。
 *
 * developer の**破壊的操作**。JIT 昇格（assertElevated・platform 全体スコープ）必須 + 理由つき監査。
 * message は運用者記述で PII/機密を書かない運用（横断 read 行に createdBy は載せない）。
 * 認可: 未認証 401 / 非 developer 403 / 未昇格 403 elevation_required。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const gate = await assertElevated();
  if (!gate.ok) return gate.response;

  const input = ((await request.json().catch(() => ({}))) ?? {}) as MaintenanceWindowInput & { reason?: unknown };
  const built = buildMaintenanceWindow(input, { id: randomUUID(), now: new Date(), createdBy: 'platform' });
  if (!built.ok) {
    return NextResponse.json({ error: 'invalid_input', message: built.error }, { status: 400 });
  }

  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 500) : undefined;
  // 監査を先に記録してから確定する（audit 失敗時に未監査の変更を残さない）。
  await recordDangerAction({
    action: 'platform.maintenance.scheduled',
    target: { type: 'maintenance_window', id: built.value.id },
    reason: reason || undefined,
    metadata: { scope: built.value.scope, impact: built.value.impact, status: built.value.status },
    request,
  });
  await createMaintenanceWindow(built.value);

  return NextResponse.json(
    {
      window: {
        id: built.value.id,
        scope: built.value.scope,
        status: built.value.status,
        impact: built.value.impact,
        startsAt: built.value.startsAt,
        endsAt: built.value.endsAt,
      },
    },
    { status: 201 },
  );
}
