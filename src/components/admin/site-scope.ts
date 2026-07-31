/**
 * 管理画面の「いまどの拠点を見ているか」を URL クエリへ載せるための純関数 (issue #421)。
 *
 * **なぜ要るか**: 拠点別の設定画面は、検索・フィルタ・ページを `useQueryParams` で URL に
 * 同期しているのに、**その画面のスコープそのものである拠点だけがコンポーネント内の state**
 * だった。結果、リロード・共有 URL・戻る/進むでフィルタは復元されるのに拠点は先頭へ戻る。
 *
 * #421 の受入条件「管理者が現在の対象 tenant/site/kiosk を見失わない」「拠点詳細から全関連
 * 設定へ到達できる」は、拠点が URL で表現できて初めて成立する（そうでなければ拠点詳細から
 * 張るリンクは**拠点を伝えられないただの画面遷移**になる）。
 *
 * スコープの真実源は URL（`docs/admin-spa-design.md` の方針）。ここでは新しい状態ストアを
 * 並立させない。
 */

/** 一覧 API が返すサイトのうち、選択に必要な最小形。 */
export type SelectableSite = { id: string };

/**
 * URL 由来の希望 siteId と実在サイト一覧から、選択すべき siteId を決める。
 *
 * **URL は利用者が自由に書ける入力なので、そのまま選択状態にしない。** 実在しない
 * （あるいは権限外で一覧に出てこない）id を採用すると、空の一覧が「この拠点には端末が
 * 無い」と読めてしまい、事実と異なる状態を見せる。実在確認できないときは先頭へ倒す。
 * 選択中テナント cookie を actor の権限で検証してから使う `resolveActiveTenantId`
 * （src/lib/tenant/active-tenant.ts）と同じ安全側の倒し方に揃えている。
 *
 * なお表示スコープの解決は UX であって認可ではない。実際の認可は API 側が actor を正として
 * 検証する（`docs/multitenant-design.md` §認可）。
 */
export function resolveSelectedSiteId(
  requested: string,
  sites: readonly SelectableSite[],
): string {
  if (requested !== '' && sites.some((s) => s.id === requested)) return requested;
  return sites[0]?.id ?? '';
}

/**
 * **既定拠点をサーバから受け取る画面向け**の解決（営業時間・呼び出しルート等）。
 *
 * これらの画面は `resolveDefaultScope()` の拠点を prop で受け取り、初回描画から取得を始める。
 * `resolveSelectedSiteId` をそのまま使うと**拠点一覧が届くまで空文字**になり、
 * `siteId=` 空のまま API を叩いてしまう。一覧が未取得の間は既定拠点を保つ。
 *
 * 一覧が届いた後の規則は `resolveSelectedSiteId` と同じ（実在しない指定は採用しない）。
 * ただし **URL 未指定のときは先頭ではなく既定拠点を保つ** — 既定拠点が先頭とは限らず
 * （env で上書きできる）、画面を開いただけで別拠点へ移るのは事故のもとなので。
 */
export function resolveSiteScope(
  requested: string,
  sites: readonly SelectableSite[],
  fallbackSiteId: string,
): string {
  if (sites.length === 0) return fallbackSiteId;
  if (requested !== '' && sites.some((s) => s.id === requested)) return requested;
  return fallbackSiteId;
}
