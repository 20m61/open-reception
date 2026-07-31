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
 * `siteId` に加えて **`ready`（この拠点で取得を始めてよいか）** を返すのが要点。
 * 「一覧が未取得の間は既定拠点を返す」だけにすると、`?siteId=branch-site` を開いたときに
 * **default → branch の順で 2 本の要求が飛ぶ**。両者を突き合わせないと、遅れて届いた
 * default の応答が branch の内容を上書きし、**選択中の拠点と画面の中身がずれる**。
 * その状態で保存すれば他拠点の設定を壊す。だから確定するまで取得させない。
 *
 * **URL 未指定のときは先頭ではなく既定拠点を保つ** — 既定拠点が先頭とは限らず
 * （env で上書きできる）、画面を開いただけで別拠点へ移るのは事故のもとなので。
 */
export function resolveSiteScopeState(
  requested: string,
  sites: readonly SelectableSite[],
  fallbackSiteId: string,
): { siteId: string; ready: boolean } {
  // URL 指定が無ければ曖昧さが無い。一覧を待たずに確定してよい。
  if (requested === '') return { siteId: fallbackSiteId, ready: true };

  // 指定があるのに一覧が未取得＝**まだ検証できない**。ここで既定拠点を返して取得を
  // 始めてしまうと、deep link のたびに間違った拠点への要求が先に飛び、応答順が入れ替わると
  // 選択中でない拠点の内容が最後に画面へ載る（そのまま保存すれば他拠点の設定を壊す）。
  if (sites.length === 0) return { siteId: fallbackSiteId, ready: false };

  if (sites.some((s) => s.id === requested)) return { siteId: requested, ready: true };
  return { siteId: fallbackSiteId, ready: true };
}
