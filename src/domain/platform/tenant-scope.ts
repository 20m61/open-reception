/**
 * 対象テナントによる read スコープ絞り込み (issue #83 inc3b-2 / #90)。
 *
 * プラットフォーム運用コンソールで対象テナントを選択しているとき、テナント横断 read を
 * 「選択テナントに関係するもの」に絞る純関数。障害（Incident）・予定メンテナンス
 * （MaintenanceWindow）など、`scope` と `tenantId` を持つ要素に共通で使う。
 *
 * 絞り込み規則:
 *   - 選択なし（selectedId=null）→ 全件（全テナント横断）。
 *   - 選択あり → `scope==='platform'`（全体影響＝全テナントに関係）か、`tenantId===selectedId`
 *     のものだけを残す。site/device スコープでも tenantId が一致すれば残す。
 */

/** scope と任意の tenantId を持つ要素（Incident / MaintenanceWindow が満たす）。 */
export type TenantScoped = { scope: string; tenantId?: string };

/** 単一要素が選択テナントの read に含まれるか。selectedId=null は常に true。 */
export function scopeIncludesSelectedTenant(
  item: TenantScoped,
  selectedId: string | null,
): boolean {
  if (!selectedId) return true;
  if (item.scope === 'platform') return true;
  return item.tenantId === selectedId;
}

/** 選択テナントに関係する要素だけへ絞り込む純関数（順序は保持）。 */
export function filterToSelectedTenant<T extends TenantScoped>(
  items: readonly T[],
  selectedId: string | null,
): T[] {
  if (!selectedId) return [...items];
  return items.filter((item) => scopeIncludesSelectedTenant(item, selectedId));
}
