import { NextResponse } from 'next/server';
import { getVisitorDirectory } from '@/lib/organization/organization-service';
import { defaultTenantIdFrom } from '@/lib/tenant/default-scope';

/**
 * GET /api/kiosk/directory — 受付端末向けの部署・担当者一覧 (issue #3)。
 * 有効な部署・担当者の最小情報のみを返す（内部情報は含めない）。
 *
 * 導出は product-context の directory セクションと**同じ** `getVisitorDirectory` を使う。
 * ここだけ別経路にすると、移行期に「API と画面で見えるものが違う」食い違いが生まれる。
 * （この個別 API 自体は #419 B-03 で撤去予定。）
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    await getVisitorDirectory({ kind: 'tenant', tenantId: defaultTenantIdFrom() }),
  );
}
