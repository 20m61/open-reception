/**
 * プラットフォーム運用コンソールの「対象テナント選択」状態 (issue #83 inc3b / #90)。
 *
 * developer がコンソールで対象テナントを選び、選択中テナントを常時表示し、read スコープを
 * 絞り込むための最小の状態。選択は Cookie（`or_platform_tenant`）に id のみを保持する。
 * 値の解決・検証はここに置く純関数で行い、Cookie 文字列の解析と「選択中テナント or 横断」の
 * 判定をテスト可能にする（I/O は持たない）。
 *
 * 注意: Cookie には id（高エントロピーではない運用識別子）のみを保持し、PII・機密値は持たない。
 * read スコープの絞り込み自体は各 read 側で `resolveSelectedTenant` の結果を使って行う。
 */

/** 対象テナント選択を保持する Cookie 名。 */
export const SELECTED_TENANT_COOKIE = 'or_platform_tenant';

/** 名前を持つテナント（一覧行・詳細など）。解決の最小形。 */
export type NamedTenant = { id: string; name: string };

/**
 * `document.cookie` 形式（`a=1; b=2`）から対象テナント id を取り出す純関数。
 * 未設定・空は null（= 全テナント横断）。
 */
export function parseSelectedTenantId(cookieString: string | undefined | null): string | null {
  if (!cookieString) return null;
  for (const part of cookieString.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== SELECTED_TENANT_COOKIE) continue;
    const value = decodeURIComponent(part.slice(eq + 1).trim());
    return value === '' ? null : value;
  }
  return null;
}

/**
 * テナント一覧と選択 id から「選択中テナント」を解決する純関数。
 * - selectedId が null → null（全テナント横断）。
 * - 一覧に存在しない id → null（消えたテナントを選択中に残さない＝横断へフォールバック）。
 */
export function resolveSelectedTenant<T extends NamedTenant>(
  tenants: readonly T[],
  selectedId: string | null,
): T | null {
  if (!selectedId) return null;
  return tenants.find((t) => t.id === selectedId) ?? null;
}

/** ヘッダ等に出す対象テナントの表示ラベル。未選択は「全テナント横断」。 */
export function selectedTenantLabel(tenant: NamedTenant | null): string {
  return tenant ? tenant.name : '全テナント横断';
}
