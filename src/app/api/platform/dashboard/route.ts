import { NextResponse } from 'next/server';
import { getTenantStore } from '@/lib/tenant/store';
import { summarizeTenantFleet } from '@/domain/platform/console-summary';
import { authorizePlatform } from '@/lib/platform/request';

/**
 * GET /api/platform/dashboard — プラットフォーム概況サマリ (issue #90, increment 1)。
 *
 * developer 専用の read-only 集約 API。フロントが複数 API を叩かずに済むよう、
 * 全テナントの稼働概況を 1 度にまとめて返す。来訪者・担当者 PII は含めない。
 *
 * 認可: authorizePlatform()（未認証 401 / 非 developer 403）。
 * 未接続指標（直近エラー・外部連携/認証エラー・総利用量・コスト概算・メンテナンス）は
 * status:'pending' のプレースホルダで明示し、本実装は次増分で接続する。
 */
export async function GET(): Promise<NextResponse> {
  const auth = await authorizePlatform();
  if (!auth.ok) return auth.response;

  const tenants = await getTenantStore().tenants.listTenants();
  const fleet = summarizeTenantFleet(tenants);

  // 未接続の運用指標。フロントに「未接続（pending）」と明示させるためのスキーマ。
  const pending = { status: 'pending' as const };

  return NextResponse.json({
    fleet,
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
