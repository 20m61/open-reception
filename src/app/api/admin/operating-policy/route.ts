import { NextResponse } from 'next/server';
import { assertCanReadSite, assertCanWriteSite, requireActor, toGuardResponse } from '@/lib/admin/guard';
import { readJson } from '@/lib/data-stores/result-http';
import { getOperatingPolicy, upsertOperatingPolicy } from '@/lib/operating-policy/store';
import { readOperatingScope, requireActorWithIdentity } from '@/lib/operating-policy/request';

/**
 * GET /api/admin/operating-policy?tenantId=&siteId= — サイト単位の営業時間ポリシーを取得する (issue #367)。
 * PUT /api/admin/operating-policy                    — 作成/更新する（body に tenantId/siteId を含む）。
 *
 * 認可（`.claude/rules/admin-api-authz.md`）: `requireActor` + `assertCanReadSite`/`assertCanWriteSite`。
 * viewer は書込不可（403）。他テナント/サイトの越境も 403。
 * 検証: 保存前に `validatePolicyInput`（逆転区間・オーバーラップ・不正フォーマット）で 400（issues 同梱）。
 * 監査: 更新を `site.updated`（metadata.resource='operating_policy'）で記録する（`lib/operating-policy/store.ts`）。
 */

const STATUS_BY_CODE = { invalid_input: 400 } as const;

export async function GET(request: Request): Promise<NextResponse> {
  const scope = readOperatingScope(new URL(request.url).searchParams);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });
  try {
    const actor = await requireActor();
    assertCanReadSite(actor, scope.tenantId, scope.siteId);
  } catch (err) {
    return toGuardResponse(err);
  }
  const policy = await getOperatingPolicy(String(scope.tenantId), String(scope.siteId));
  return NextResponse.json({ policy });
}

export async function PUT(request: Request): Promise<NextResponse> {
  const body = await readJson(request);
  const scope = readOperatingScope((body ?? {}) as Record<string, unknown>);
  if (!scope.ok) return NextResponse.json(scope.error, { status: 400 });

  let identity: string;
  try {
    const resolved = await requireActorWithIdentity();
    assertCanWriteSite(resolved.actor, scope.tenantId, scope.siteId);
    identity = resolved.identity;
  } catch (err) {
    return toGuardResponse(err);
  }

  const result = await upsertOperatingPolicy(String(scope.tenantId), String(scope.siteId), identity, body);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error.code, message: result.error.message, issues: result.error.issues },
      { status: STATUS_BY_CODE[result.error.code] },
    );
  }
  return NextResponse.json({ policy: result.value });
}
