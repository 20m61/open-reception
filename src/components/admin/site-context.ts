import { SITE_DETAIL_PATH_PATTERN, SITE_SCOPED_PATHS } from './site-destinations';
import { resolveSiteScopeState, type SelectableSite } from './site-scope';

/**
 * 「いまどの拠点を見ているか」をヘッダに常設するための純関数
 * (issue #423「共通コンテキストバー `Platform > Tenant > Site > Kiosk > Version`」の Site 次元)。
 *
 * ## なぜ要るか
 *
 * 対象テナントはヘッダに常設されている（`TenantContextView`）のに、**対象拠点は各画面の本文に
 * ある `SiteScopeSelect` にしか無い**。拠点詳細 `/admin/sites/[siteId]` に至っては本文にも
 * セレクタが無く、URL を見ない限りどの拠点を見ているか分からない。#423 の受入条件
 * 「主要画面で現在の tenant/site が常に確認できる」はこれで落ちている。
 *
 * ## ヘッダは本文と同じ拠点を指さなければならない
 *
 * 第 84 wave で platform に実在した事故と同じ形を作らないこと: ヘッダが Cookie の選択を、
 * 本文が URL のテナントを出していたため、**ヘッダと本文が別のテナントを示し得た**。
 * よってここでは既定拠点への倒し方を独自に書かず、本文が使う `resolveSiteScopeState` へ
 * **委譲する**（テストでも両者の一致を固定している）。
 *
 * ## route（拠点詳細）だけは黙って倒さない
 *
 * `/admin/sites/<id>` は運用者が「この拠点について見る」と明示した対象。一覧に無いときに
 * 既定拠点へ倒すと、**別拠点の情報を見ているのに気づけない**（#423「画面移動によって対象が
 * 暗黙に切り替わらない」）。`unknown` として明示する。
 *
 * ## 認可ではない
 *
 * 表示スコープの解決は UX であって認可ではない。実際の認可は各 API が actor を正として
 * 検証する（`docs/multitenant-design.md` §認可）。PII は扱わない（拠点 id と拠点名のみ）。
 */

/**
 * 拠点一覧の取得状態。`useSiteList` が返すものと同じ語彙。
 * `idle` は「そもそも取りに行っていない」（拠点次元を持たない画面）。
 */
export type SiteListStatus = 'idle' | 'loading' | 'ready' | 'error';

export type AdminSiteContext =
  /** その画面は拠点 1 つにスコープされていない（テナント全体の画面・一覧画面）。 */
  | { kind: 'not-scoped' }
  /** 拠点別画面だが一覧が未確定。**まだ何も断定しない。** */
  | { kind: 'loading' }
  /** 拠点別画面だが一覧を確認できない（取得失敗・拠点ゼロ）。既定拠点を騙らない。 */
  | { kind: 'unavailable' }
  /** URL が名指しする拠点が一覧に無い（失効・越境・打ち間違い）。 */
  | { kind: 'unknown'; siteId: string }
  | {
      kind: 'resolved';
      siteId: string;
      /** 表示名。名前が無ければ id をそのまま出す（空欄にしない）。 */
      siteName: string;
      /** 何が対象を決めたか。`route` = 拠点詳細の URL、`query` = `?siteId=`、`default` = 既定拠点。 */
      source: 'route' | 'query' | 'default';
    };

/** `/admin/sites/<id>` から拠点 id を取り出す。一覧 `/admin/sites` と一覧配下は対象外。 */
export function siteIdFromPathname(pathname: string): string | null {
  const captured = /^\/admin\/sites\/([^/]+)\/?$/.exec(pathname)?.[1];
  return captured === undefined ? null : decodeURIComponent(captured);
}

/** 末尾スラッシュを落とした比較用パス（`/admin/` そのものは落とさない）。 */
function normalizePathname(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

/** その画面が `?siteId=` で拠点を運ぶ画面か（登録簿が単一情報源）。 */
function isQueryScopedPath(pathname: string): boolean {
  return SITE_SCOPED_PATHS.filter((p) => p !== SITE_DETAIL_PATH_PATTERN).includes(pathname);
}

/**
 * その画面が拠点 1 つにスコープされているか。**一覧を取りに行く前に**判定できる
 * （拠点次元を持たない画面で `/api/admin/sites` を叩かないため）。
 */
export function isSiteScopedPathname(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return siteIdFromPathname(normalized) !== null || isQueryScopedPath(normalized);
}

export function resolveAdminSiteContext(input: {
  pathname: string;
  /** `?siteId=`。未指定は空文字（`useQueryParams().get` と同じ表現）。 */
  requestedSiteId: string;
  sites: readonly (SelectableSite & { name?: string })[];
  status: SiteListStatus;
  /** サーバが解決した既定拠点（`resolveDefaultScope().siteId`）。 */
  fallbackSiteId: string;
}): AdminSiteContext {
  const pathname = normalizePathname(input.pathname);
  if (!isSiteScopedPathname(pathname)) return { kind: 'not-scoped' };
  const routeSiteId = siteIdFromPathname(pathname);

  if (input.status === 'loading' || input.status === 'idle') return { kind: 'loading' };
  if (input.status === 'error' || input.sites.length === 0) return { kind: 'unavailable' };

  const named = (siteId: string, source: 'route' | 'query' | 'default'): AdminSiteContext => {
    const site = input.sites.find((s) => s.id === siteId);
    if (site === undefined) return { kind: 'unknown', siteId };
    return { kind: 'resolved', siteId, siteName: site.name ?? site.id, source };
  };

  // route は最も具体的な意思。`?siteId=` が併記されていても route が勝つ。
  if (routeSiteId !== null) return named(routeSiteId, 'route');

  // 拠点別設定画面は本文と同じ解決に委譲する（ヘッダと本文をずらさない）。
  const body = resolveSiteScopeState(input.requestedSiteId, input.sites, input.fallbackSiteId);
  if (!body.ready) return { kind: 'loading' };
  return named(body.siteId, body.siteId === input.requestedSiteId ? 'query' : 'default');
}
