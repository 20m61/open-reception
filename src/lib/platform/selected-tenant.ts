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

import { resolveContextScope } from '@/domain/tenant/context-scope';

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

/**
 * URL が名指しするテナント id を取り出す純関数 (#423 配線)。
 *
 * `/platform/tenants/<id>` とその配下（子ページを増やしても壊れない）にだけ一致する。
 * 一覧（`/platform/tenants`）はテナントを名指ししていないので `null`。
 *
 * **ここで得た id は権威ではない**（URL は誰でも打てる）。採用の可否は
 * `resolveContextScope` が server resolved の許可集合で濾す。
 */
export function routeTenantIdFrom(pathname: string): string | null {
  const match = /^\/platform\/tenants\/([^/]+)/.exec(pathname);
  const raw = match?.[1];
  if (raw === undefined || raw === '') return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    // 壊れたパーセントエンコードは「名指ししていない」として扱う（例外で画面を壊さない）。
    return null;
  }
}

/** ヘッダに出す「いま見ているテナント」。 */
export type ViewingContext = {
  /** 表示すべきテナント名。`null` なら出さない（URL が名指ししていない／権威に無い／未取得）。 */
  tenantName: string | null;
  /** 選択中（sticky）と別か。UI が「選択中と別」を併記するのに使う。 */
  differsFromSticky: boolean;
};

/**
 * pathname と sticky 選択と許可済みテナント一覧から、ヘッダの「表示中」を導出する。
 *
 * **`resolveContextScope`（#423 の優先順位契約）の消費者。** 判定の本体は契約側にあり、ここは
 * 「id → 表示名」の解決だけを足す。契約に消費者を置くのが目的で、判定を二重に持たない。
 *
 * `differsFromSticky` が false でも `tenantName` は出す場合がある（sticky 未選択で URL が
 * テナントを名指ししているとき）。**ここを取り違えると「全テナント横断」と表示しながら
 * 1 テナントの詳細を見ている状態が残る**（本増分が直した実害そのもの）。
 */
export function resolveViewingContext({
  pathname,
  stickyTenantId,
  tenants,
}: {
  pathname: string;
  stickyTenantId: string | null;
  /** 許可済みテナント（developer 専用 read API の結果）。未取得なら空配列。 */
  tenants: readonly NamedTenant[];
}): ViewingContext {
  const scope = resolveContextScope({
    routeTenantId: routeTenantIdFrom(pathname),
    stickyTenantId,
    authorizedTenantIds: tenants.map((t) => t.id),
  });
  if (scope.source !== 'route' || scope.tenantId === null) {
    return { tenantName: null, differsFromSticky: false };
  }
  const tenant = tenants.find((t) => t.id === scope.tenantId);
  return {
    tenantName: tenant?.name ?? null,
    differsFromSticky: scope.differsFromSticky,
  };
}
