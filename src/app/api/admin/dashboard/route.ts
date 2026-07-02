import { NextResponse } from 'next/server';
import { accessibleTenants, type AccessibleTenants } from '@/domain/tenant/authorization';
import { listReceptionLogs } from '@/lib/data-stores/reception-log-store';
import {
  summarizeDeviceFleet,
  summarizeDeviceFleetForTenants,
} from '@/lib/tenant/device-fleet';
import { loadUsage, loadCostEstimate } from '@/lib/usage/usage-data';
import { forbidden, requireActor, toGuardResponse } from '@/lib/admin/guard';
import {
  buildDashboardSummary,
  type UsageCostSummary,
} from '@/domain/reception/dashboard-summary';

/**
 * GET /api/admin/dashboard — テナント管理者向け概況サマリ (issue #86, increment 1)。
 *
 * ダッシュボードはフロントで複数 API を過剰に叩いて組み立てず、本集約 API が
 * 受付履歴・端末死活・利用量/予想コスト概況を 1 度にまとめて返す（#86 データ方針）。
 * 来訪者 PII は含めない。利用量/コストの詳細は /admin/usage・/admin/costs へ誘導する。
 *
 * 端末稼働 (#261 → #284 item4): enabled フラグではなく、platform オブザーバビリティと同一の
 * 共有供給層（device-fleet: kiosk/Device union の実 heartbeat 死活）から供給する。
 * 実 actor（#85）を解決し、テナント境界付き actor には accessibleTenants の自テナント集合のみ
 * を集計した summarizeDeviceFleetForTenants、developer（全テナント横断）には従来どおり
 * TTL キャッシュ付き横断集計 summarizeDeviceFleet を返す。クライアントが送る値ではなく
 * actor の RoleAssignment を境界の正とする（rules/admin-api-authz.md）。
 * 未認証は 401、テナント割り当てを 1 件も持たない actor は 403（境界を確定できないまま
 * 集計を返さない）。
 *
 * NOTE: 受付履歴・利用量/コストは単一テナント既定運用のグローバルストア供給のまま
 * （テナント別ストア分離は #274/#85 系の別増分）。本増分のスコープは死活集計の境界適用。
 */
export async function GET(): Promise<NextResponse> {
  let scope: AccessibleTenants;
  try {
    const actor = await requireActor();
    scope = accessibleTenants(actor);
    if (scope.scope === 'tenants' && scope.tenantIds.length === 0) throw forbidden();
  } catch (err) {
    return toGuardResponse(err);
  }
  const now = new Date();
  // NOTE: recentCalls（直近の呼び出し履歴）は日付非依存で全履歴から直近 N 件を引くため、ここは境界
  // クエリにできない（当月に絞ると月境界/閑散期に履歴が空になる。#254 では platform/usage のみ境界化）。
  // 端末死活: developer は device-fleet の TTL キャッシュ越し横断集計、テナント境界付き actor は
  // 自テナントのみの境界クエリ集計（リクエスト毎のフルスキャンはどちらもしない, #261/#284）。
  const [logs, devices, usage, cost] = await Promise.all([
    listReceptionLogs(),
    scope.scope === 'all'
      ? summarizeDeviceFleet(now)
      : summarizeDeviceFleetForTenants(scope.tenantIds, now),
    loadUsage(now),
    loadCostEstimate(now),
  ]);
  const usageCost: UsageCostSummary = {
    receptionsThisMonth: usage.current.receptions,
    estimatedSoFar: cost.estimatedSoFar,
    projectedMonthEnd: cost.projectedMonthEnd,
    currency: cost.currency,
  };
  return NextResponse.json(buildDashboardSummary(logs, devices, now, usageCost));
}
