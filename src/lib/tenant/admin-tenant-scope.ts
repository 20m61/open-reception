import type { Actor } from '@/domain/tenant/authorization';
import { requireActor } from '@/lib/admin/guard';
import { resolveActiveTenant } from './active-tenant';
import { resolveDefaultScope } from './default-scope';

/**
 * 管理画面のサーバコンポーネントが使う「**表示対象テナント**」の解決 (issue #421)。
 *
 * 拠点別の設定画面は長らく `resolveDefaultScope()`（env 由来の既定テナント）で決め打って
 * いたが、拠点 ID は**テナント内のスコープ**なので、これだとテナントを切り替えた
 * developer / 複数テナント管理者に対して「その拠点は無い」と誤表示するか、
 * **同じ ID が既定テナントにも在れば別テナントの設定を表示・操作させてしまう**。
 *
 * ヘッダの TenantSwitcher と同じ `resolveActiveTenant`（cookie を actor の
 * `accessibleTenants` で検証し、越境値は採用しない）に揃える。所属が解決できないとき
 * （未所属・初期状態）だけ既定スコープへ倒す。
 *
 * **これは表示スコープの解決であって認可ではない。** 実際の認可は各 API / service が
 * actor を正として検証する（`docs/multitenant-design.md` §認可）。
 *
 * 新しい拠点別画面を足すときは必ずこれを通すこと。
 * `tests/config/admin-tenant-scope.test.ts` が実ファイルを走査して強制する。
 */
export async function resolveAdminTenantId(actor?: Actor): Promise<string> {
  const resolved = actor ?? (await requireActor());
  const { activeTenantId } = await resolveActiveTenant(resolved);
  return String(activeTenantId ?? resolveDefaultScope().tenantId);
}
