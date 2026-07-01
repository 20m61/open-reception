import { NextResponse } from 'next/server';
import { getTenantStore } from '@/lib/tenant/store';
import { summarizeTenantFleet } from '@/domain/platform/console-summary';
import { summarizeToday } from '@/domain/reception/dashboard-summary';
import { listReceptionLogs } from '@/lib/mock-backend/reception-log-store';
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

  const tenants = await getTenantStore().tenants.listTenants();
  const fleet = summarizeTenantFleet(tenants);

  // 本日の受付活動（全テナント横断）。件数のみで PII は含まない (#83 AC3)。
  const receptionsToday = summarizeToday(await listReceptionLogs());

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
