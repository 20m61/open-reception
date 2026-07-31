import { SiteDetail } from '@/components/admin/SiteDetail';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';

export const dynamic = 'force-dynamic';

/**
 * 管理画面: 拠点詳細 (issue #421)。
 *
 * #421 の情報構造（テナント→拠点→端末→受付体験）の結節点。この拠点に関わる設定へ
 * ここから到達できるようにする。拠点を運べる導線には `?siteId=` が付く
 * （`src/components/admin/site-destinations.ts` が登録簿）。
 *
 * テナントは既存 admin 慣例（`resolveDefaultScope`）で解決する。拠点は URL パスが正。
 */
export default async function AdminSiteDetailPage({
  params,
}: {
  params: Promise<{ siteId: string }>;
}) {
  const { siteId } = await params;
  const scope = resolveDefaultScope();
  return <SiteDetail tenantId={String(scope.tenantId)} siteId={siteId} />;
}
