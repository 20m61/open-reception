import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { summarizeUpdateStatuses } from '@/domain/platform/update-status';
import { listUpdateStatuses } from '@/lib/platform/update-status-store';
import { filterToSelectedTenant } from '@/domain/platform/tenant-scope';
import { SELECTED_TENANT_COOKIE } from '@/lib/platform/selected-tenant';
import { authorizePlatform } from '@/lib/platform/request';

/**
 * GET /api/platform/updates — アップデート状況の横断 read (issue #83 AC6)。
 *
 * developer 専用の read-only API。Tenant/Site/Device 単位のアップデート状況を横断集計し、
 * 対応が要る（更新待ち/更新中/失敗）ものを優先して並べ、pending 件数と状況内訳を返す。
 * 来訪者/担当者 PII・操作者識別子は含めない（射影 whitelist）。
 *
 * 対象テナント選択: Cookie（or_platform_tenant）が設定されていれば「全体影響（scope=platform）か
 * 選択テナント」に絞る（incident/maintenance と同方式）。
 *
 * 実際の更新実行（デプロイ/ロールバック）は破壊的操作のため本 API では提供せず、画面側で影響範囲
 * 表示・昇格・監査を伴う導線に隔離する。
 *
 * 認可: authorizePlatform()（未認証 401 / 非 developer 403）。
 */
export async function GET(): Promise<NextResponse> {
  const auth = await authorizePlatform();
  if (!auth.ok) return auth.response;

  const selectedTenantId = (await cookies()).get(SELECTED_TENANT_COOKIE)?.value || null;
  const updates = summarizeUpdateStatuses(
    filterToSelectedTenant(await listUpdateStatuses(), selectedTenantId),
  );
  return NextResponse.json({ updates });
}
