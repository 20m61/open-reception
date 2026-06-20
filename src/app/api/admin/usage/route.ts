import { NextResponse } from 'next/server';
import { resolveUsageScope } from '@/lib/usage/request';
import { loadUsage } from '@/lib/usage/usage-data';

/**
 * GET /api/admin/usage?tenantId= — テナントの業務単位利用量サマリ (issue #89, increment 1)。
 *
 * 当月・前月の受付件数 / 通話成否 / 通話分数 / 代替導線などを read 専用で返す。
 * 認証は resolveAdminActor、テナント境界は canAccessTenant（read）で判定する。
 * 来訪者 PII は含めない。集計ロジックは domain/usage の純関数に閉じる。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const scope = await resolveUsageScope(new URL(request.url).searchParams);
  if (!scope.ok) return scope.response;
  return NextResponse.json(await loadUsage());
}
