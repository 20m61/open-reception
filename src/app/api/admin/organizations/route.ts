import { NextResponse } from 'next/server';
import {
  assertCanRead,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';
import { getOrganizationView } from '@/lib/organization/organization-service';
import { resolveAdminTenantId } from '@/lib/tenant/admin-tenant-scope';
import { asTenantId } from '@/domain/tenant/types';

/**
 * GET /api/admin/organizations — 組織一覧（無効・非公開も含む） (#373 増分 5)。
 *
 * 返すのは**合成ビュー**（既存 `Department` 由来の互換組織 + 保存済み組織）。運用者から見て
 * 「部署管理に在るのに組織一覧に無い」という食い違いを作らないため、片方だけを返さない。
 *
 * 認可（#91 inc2）: middleware の入口ガードに加え、route 側で実 actor を解決し
 * `requireActor` + `assertCanRead` で **最終認可** を行う。
 *
 * 管理向けなので `officialName`（内部正式名称）を含む。**来訪者向けの経路
 * （`getVisitorDirectory`）とは別**であり、こちらの応答を kiosk へ流用しないこと。
 */
export async function GET(): Promise<NextResponse> {
  let tenantId: string;
  try {
    const actor = await requireActor();
    tenantId = await resolveAdminTenantId();
    assertCanRead(actor, asTenantId(tenantId));
  } catch (err) {
    return toGuardResponse(err);
  }
  const view = await getOrganizationView({ kind: 'tenant', tenantId });
  return NextResponse.json({
    items: view.units,
    // 部署に紐づかない担当者。**黙って捨てない**（移行漏れの信号）。
    unresolvedStaffIds: view.unresolvedStaffIds,
  });
}
