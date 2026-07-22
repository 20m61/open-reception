import { NextRequest, NextResponse } from 'next/server';
import {
  isCostComponentFilter,
  isCostEnvironmentFilter,
  type CostComponentFilter,
  type CostEnvironmentFilter,
} from '@/domain/platform/aws-cost';
import { getAwsCostSummary } from '@/lib/platform/aws-cost-explorer';
import { authorizePlatform } from '@/lib/platform/request';

/**
 * GET /api/platform/costs — developer 専用 AWS コスト read API (#377 / #379)。
 *
 * Project タグはサーバー設定値（既定 open-reception）へ固定し、クライアントから任意の
 * Cost Explorer Expression やタグキーを渡せないようにする。許可済みの Environment / Component
 * 値だけを受け付ける。AWS 側の未設定・権限不足・反映待ちは 200 + status:unavailable で返し、
 * platform ダッシュボードの他指標を巻き込んで落とさない。
 *
 * CE 課金抑制は `getAwsCostSummary` 内の Lambda プロセス内 TTL キャッシュ（フィルタ組み合わせ単位・
 * 5 分, #379）で行う。ここでは `Cache-Control` を設定しない: ブラウザのディスクキャッシュに
 * 請求データを置くとログアウト後も TTL 分（最大 5 分）残るため（#379 のレビュー指摘）。
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await authorizePlatform();
  if (!auth.ok) return auth.response;

  const environmentRaw = request.nextUrl.searchParams.get('environment');
  const componentRaw = request.nextUrl.searchParams.get('component');

  if (environmentRaw && !isCostEnvironmentFilter(environmentRaw)) {
    return NextResponse.json({ error: 'invalid_environment_filter' }, { status: 400 });
  }
  if (componentRaw && !isCostComponentFilter(componentRaw)) {
    return NextResponse.json({ error: 'invalid_component_filter' }, { status: 400 });
  }

  const summary = await getAwsCostSummary({
    environment: (environmentRaw || undefined) as CostEnvironmentFilter | undefined,
    component: (componentRaw || undefined) as CostComponentFilter | undefined,
  });

  return NextResponse.json(summary);
}
