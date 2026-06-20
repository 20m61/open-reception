import { NextResponse } from 'next/server';
import { resolveUsageScope } from '@/lib/usage/request';
import { loadCostEstimate } from '@/lib/usage/usage-data';

/**
 * GET /api/admin/costs?tenantId= — テナントの予想コスト概算 (issue #89, increment 1)。
 *
 * 当月利用量 × 単価仮定からの「概算」「月末予想」を read 専用で返す。実課金連携は次増分。
 * 出力には isEstimate / assumptions を含め、UI が断定的な金額に見せないようにする。
 * 認証は resolveAdminActor、テナント境界は canAccessTenant（read）で判定する。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const scope = await resolveUsageScope(new URL(request.url).searchParams);
  if (!scope.ok) return scope.response;
  return NextResponse.json(await loadCostEstimate());
}
