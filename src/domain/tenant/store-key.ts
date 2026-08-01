/**
 * テナント別ストアキーの決め方 (#419 残増分「グローバルストアのテナント対応」)。
 *
 * ## なぜ要るか
 *
 * `branding` / `directory` / `voice` / `motions` / `assets` は単一テナント運用の名残で
 * テナント次元を持たない（`getBackend().singleton('branding')` のような固定名）。
 * `src/lib/product-context/section-loaders.ts` は越境（テナント A の管理者が B の端末を
 * プレビューすると A の branding が出る）を避けるため、**既定テナント以外の要求を
 * fail-closed で落として**いる。安全側ではあるが、その結果
 * **2 つ目以降のテナントはこれらの機能を一切使えない** — 多テナントを謳う製品として
 * 前提が満たされていない。
 *
 * ## なぜ既定テナントだけ従来キーなのか
 *
 * 全テナントを `branding#<id>` に揃える方が綺麗だが、**稼働中の環境で保存済みの
 * 設定が読めなくなる**（永続スキーマの非互換変更＝ CLAUDE.md の停止境界）。
 * 既定テナントを従来キーに据え置けば、追加のみで済み移行が要らない。
 * 見た目の綺麗さより、動いているものを壊さないことを優先する。
 */

/** キーの区切り。id 側は encode するので、この文字が id 由来で現れることはない。 */
const SEPARATOR = '#';

export function tenantScopedStoreKey(
  /** ストア名（`branding` など）。 */
  store: string,
  /** 対象テナント。**呼び出し側で解決済みの値**を渡すこと。 */
  tenantId: string,
  /** 既定テナント（`defaultTenantIdFrom()`）。 */
  defaultTenantId: string,
): string {
  /**
   * **空を既定へ倒さない。** 倒すと、呼び出し側の解決漏れが「既定テナントのデータが
   * 出る」という形で隠れる。それは静かな越境なので、はっきり失敗させる。
   */
  if (tenantId === '') throw new Error(`tenantScopedStoreKey: tenantId is empty (store=${store})`);
  if (tenantId === defaultTenantId) return store;
  // id を encode してから連結する。素通しにすると `a#b` のような id で
  // 別ストアのキーへ化けられる（`branding#a` + `b` と衝突する）。
  return `${store}${SEPARATOR}${encodeURIComponent(tenantId)}`;
}
