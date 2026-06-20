import { NextResponse } from 'next/server';
import { getTenantStore } from '@/lib/tenant/store';
import { summarizeTenantFleet, toTenantRows } from '@/domain/platform/console-summary';
import { authorizePlatform } from '@/lib/platform/request';

/**
 * GET /api/platform/tenants — 全テナント一覧（テナント横断 read） (issue #90, increment 1)。
 *
 * developer 専用の read-only API。テナントのメタ情報（名前/slug/状態/更新日時）のみを
 * 返し、機密値・来訪者/担当者 PII は含めない。有効/停止の切り替え等の破壊的操作は
 * 次増分で昇格・理由入力・確認・監査を伴って実装する（本増分では提供しない）。
 *
 * 認可: authorizePlatform()（未認証 401 / 非 developer 403）。
 */
export async function GET(): Promise<NextResponse> {
  const auth = await authorizePlatform();
  if (!auth.ok) return auth.response;

  const tenants = await getTenantStore().tenants.listTenants();
  return NextResponse.json({
    summary: summarizeTenantFleet(tenants),
    tenants: toTenantRows(tenants),
  });
}
