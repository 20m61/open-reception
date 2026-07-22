import { NextResponse } from 'next/server';
import { readJson } from '@/lib/data-stores/result-http';
import { getRoutingService } from '@/lib/routing/store';
import { readRoutingScope, resolveAdminActor, routingResponse } from '@/lib/routing/request';
import { parseRoutingPolicyBody } from '@/lib/routing/input';

/**
 * GET  /api/admin/routing/policies?tenantId=&siteId= — ルーティングポリシー一覧（文章形式説明つき） (issue #374)。
 * POST /api/admin/routing/policies                    — ポリシーを作成する。
 *
 * 認証: 管理セッション必須（無効なら 401）。
 * 認可: #80 純関数で境界・write 権限を判定（service 層）。
 * 検証: 保存前に validateRoutingPolicySet（循環・整合）で不正は 400（issues 同梱）。
 * 監査: 作成を PII なしで記録する（routing_policy.created）。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const scope = readRoutingScope(new URL(request.url).searchParams);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  const result = await getRoutingService().listPolicies(actor, scope.tenantId, scope.siteId);
  return routingResponse(result);
}

export async function POST(request: Request): Promise<NextResponse> {
  const actor = await resolveAdminActor();
  if (!actor) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await readJson(request);
  const scope = readRoutingScope((body ?? {}) as Record<string, unknown>);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });

  const parsed = parseRoutingPolicyBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error.code, message: parsed.error.message }, { status: 400 });

  const result = await getRoutingService().createPolicy(actor, { tenantId: scope.tenantId, body: parsed.value });
  return routingResponse(result, 201);
}
