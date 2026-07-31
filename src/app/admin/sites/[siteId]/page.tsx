import { SiteDetail } from '@/components/admin/SiteDetail';
import { requireActor } from '@/lib/admin/guard';
import { resolveActiveTenant } from '@/lib/tenant/active-tenant';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';

export const dynamic = 'force-dynamic';

/**
 * 管理画面: 拠点詳細 (issue #421)。
 *
 * #421 の情報構造（テナント→拠点→端末→受付体験）の結節点。この拠点に関わる設定へ
 * ここから到達できるようにする。拠点を運べる導線には `?siteId=` が付く
 * （`src/components/admin/site-destinations.ts` が登録簿）。
 *
 * **テナントは `resolveDefaultScope()` ではなく選択中テナントで解決する。**
 * 拠点 ID はテナント内でのスコープなので、既定テナント固定にすると、テナントを切り替えた
 * developer / 複数テナント管理者に対して「その拠点は無い」と誤表示するか、**同じ ID が
 * 既定テナントにも在れば別テナントの設定を表示・リンクしてしまう**（#536 レビュー P1）。
 * ヘッダの TenantSwitcher と同じ `resolveActiveTenant`（cookie を actor の権限で検証し、
 * 越境値は採用しない）を使って表示対象を揃える。
 *
 * 表示スコープの解決は UX であって認可ではない。実際の認可は各 API が actor を正として
 * 検証する（`docs/multitenant-design.md` §認可）。
 */
export default async function AdminSiteDetailPage({
  params,
}: {
  params: Promise<{ siteId: string }>;
}) {
  const { siteId } = await params;
  const actor = await requireActor();
  const { activeTenantId } = await resolveActiveTenant(actor);
  // 所属テナントが解決できない場合のみ既定スコープへ倒す（未所属・初期状態）。
  const tenantId = activeTenantId ?? resolveDefaultScope().tenantId;
  return <SiteDetail tenantId={String(tenantId)} siteId={siteId} />;
}
