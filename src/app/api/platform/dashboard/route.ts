import { NextResponse } from 'next/server';
import { getTenantStore } from '@/lib/tenant/store';
import { summarizeTenantFleet } from '@/domain/platform/console-summary';
import { summarizeToday } from '@/domain/reception/dashboard-summary';
import { listReceptionLogsSince } from '@/lib/data-stores/reception-log-store';
import { jstDayStartIso } from '@/domain/util/jst';
import { authorizePlatform } from '@/lib/platform/request';

/**
 * GET /api/platform/dashboard — プラットフォーム概況サマリ (issue #90, increment 1 / #83 AC3)。
 *
 * developer 専用の read-only 集約 API。フロントが複数 API を叩かずに済むよう、
 * 全テナントの稼働概況を 1 度にまとめて返す。来訪者・担当者 PII は含めない。
 *
 * 認可: authorizePlatform()（未認証 401 / 非 developer 403）。
 * 稼働指標のうち **本日の受付活動**（受付数・接続/未応答/失敗）は受付ログから実接続する (#83 AC3)。
 * 未接続指標（直近エラー・外部連携/認証エラー・総利用量・コスト概算・メンテナンス）は
 * status:'pending' のプレースホルダで明示し、後段増分で接続する。
 */
export async function GET(): Promise<NextResponse> {
  const auth = await authorizePlatform();
  if (!auth.ok) return auth.response;

  // 本日の受付活動は当日 JST 分だけ必要。全件走査を避け、本日 JST 00:00 以降を境界クエリで取る (#254)。
  const sinceToday = jstDayStartIso(new Date());
  // 独立した 2 つの read を並行取得。受付ログ取得が失敗しても本日受付だけ degrade し、fleet 概況は
  // 落とさない（受付ログは fleet に依存しない補助指標）。
  const [tenants, logs] = await Promise.all([
    getTenantStore().tenants.listTenants(),
    (sinceToday ? listReceptionLogsSince(sinceToday) : Promise.resolve([])).catch(() => []),
  ]);
  const fleet = summarizeTenantFleet(tenants);

  // 本日の受付活動（全テナント横断）。summarizeToday が JST 当日で再フィルタする。件数のみ・PII なし (#83 AC3)。
  const receptionsToday = summarizeToday(logs);

  // 未接続の運用指標。フロントに「未接続（pending）」と明示させるためのスキーマ。
  const pending = { status: 'pending' as const };

  return NextResponse.json({
    fleet,
    receptionsToday,
    metrics: {
      recentErrors: pending,
      integrationErrors: pending,
      authErrors: pending,
      totalUsage: pending,
      estimatedCost: pending,
      maintenance: pending,
    },
  });
}
