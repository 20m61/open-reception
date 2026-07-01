import { NextResponse } from 'next/server';
import { listKiosks } from '@/lib/kiosk/kiosk-store';
import { listReceptionLogs } from '@/lib/data-stores/reception-log-store';
import { loadUsage, loadCostEstimate } from '@/lib/usage/usage-data';
import {
  buildDashboardSummary,
  type DeviceLike,
  type UsageCostSummary,
} from '@/domain/reception/dashboard-summary';

/**
 * GET /api/admin/dashboard — テナント管理者向け概況サマリ (issue #86, increment 1)。
 *
 * ダッシュボードはフロントで複数 API を過剰に叩いて組み立てず、本集約 API が
 * 受付履歴・端末レジストリ・利用量/予想コスト概況を 1 度にまとめて返す（#86 データ方針）。
 * 来訪者 PII は含めない。利用量/コストの詳細は /admin/usage・/admin/costs へ誘導する。
 *
 * NOTE: 認証・認可（role / tenantId / siteId 検証）は他の admin API と同じく
 * middleware（#24）の namespace 境界に閉じる。実 actor 解決とテナント境界の
 * 厳密適用は #85 increment 2 以降（session.ts は現状 role:'admin' のみ）。
 * 本増分では既存 admin read API（receptions/kiosks/audit）と同じ責務境界に合わせる。
 */
export async function GET(): Promise<NextResponse> {
  const now = new Date();
  // NOTE: recentCalls（直近の呼び出し履歴）は日付非依存で全履歴から直近 N 件を引くため、ここは境界
  // クエリにできない（当月に絞ると月境界/閑散期に履歴が空になる。#254 では platform/usage のみ境界化）。
  const [logs, kiosks, usage, cost] = await Promise.all([
    listReceptionLogs(),
    listKiosks(),
    loadUsage(now),
    loadCostEstimate(now),
  ]);
  const devices: DeviceLike[] = kiosks.map((k) => ({
    id: k.id,
    displayName: k.displayName,
    enabled: k.enabled,
  }));
  const usageCost: UsageCostSummary = {
    receptionsThisMonth: usage.current.receptions,
    estimatedSoFar: cost.estimatedSoFar,
    projectedMonthEnd: cost.projectedMonthEnd,
    currency: cost.currency,
  };
  return NextResponse.json(buildDashboardSummary(logs, devices, new Date(), usageCost));
}
