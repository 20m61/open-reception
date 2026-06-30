/**
 * 受付エンロール URL からトークンを取り出す (issue #239)。
 *
 * トークンは **fragment**（`#token=…`）に載せる。fragment は HTTP リクエストに含まれず、サーバの
 * アクセスログ・リファラに残らないため、クエリ文字列（`?token=…`）より露出が小さい。互換のため
 * query もフォールバックで読む（移行期の旧 URL 対応）。**fragment を優先**する。
 *
 * @param parts `window.location` の `hash`（先頭 `#` 有無いずれも可）と `search`。
 */
export function tokenFromUrl(parts: { hash: string; search: string }): string {
  const fromHash = new URLSearchParams(parts.hash.replace(/^#/, '')).get('token');
  if (fromHash) return fromHash;
  return new URLSearchParams(parts.search).get('token') ?? '';
}
