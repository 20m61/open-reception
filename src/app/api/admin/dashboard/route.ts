import { NextResponse } from 'next/server';
import { listKiosks } from '@/lib/kiosk/kiosk-store';
import { listReceptionLogs } from '@/lib/mock-backend/reception-log-store';
import { buildDashboardSummary, type DeviceLike } from '@/domain/reception/dashboard-summary';

/**
 * GET /api/admin/dashboard — テナント管理者向け概況サマリ (issue #86, increment 1)。
 *
 * ダッシュボードはフロントで複数 API を過剰に叩いて組み立てず、本集約 API が
 * 受付履歴・端末レジストリを 1 度にまとめて返す。来訪者 PII は含めない。
 *
 * NOTE: 認証・認可（role / tenantId / siteId 検証）は他の admin API と同じく
 * middleware（#24）の namespace 境界に閉じる。実 actor 解決とテナント境界の
 * 厳密適用は #85 increment 2 以降（session.ts は現状 role:'admin' のみ）。
 * 本増分では既存 admin read API（receptions/kiosks/audit）と同じ責務境界に合わせる。
 */
export async function GET(): Promise<NextResponse> {
  const [logs, kiosks] = await Promise.all([listReceptionLogs(), listKiosks()]);
  const devices: DeviceLike[] = kiosks.map((k) => ({
    id: k.id,
    displayName: k.displayName,
    enabled: k.enabled,
  }));
  return NextResponse.json(buildDashboardSummary(logs, devices));
}
