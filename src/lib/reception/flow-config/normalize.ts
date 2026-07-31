/**
 * 受付フローの保存済みレコードから**撤去済みフィールド**を実行時に落とす (issue #421)。
 *
 * `callRouteId`（旧 `CallRoute` #88 への参照）は移行台帳 §5「取次モデル」の一本化で
 * 廃止したが、**型から消しても実行時のオブジェクトからは消えない**。リポジトリは保存済み
 * レコードをそのまま返し、`flowResponse` がそのまま直列化するため、撤去したはずの
 * フィールドが admin / kiosk の応答やスナップショットに出続ける。更新時も `{ ...found }`
 * で拾って書き戻してしまう。**型消去は実行時の撤去ではない。**
 *
 * 読み出しの全経路と保存の直前でこれを通し、境界で正規化する。
 *
 * 保存済みデータの移行（バックフィル）は行わない。読み書きの両端で落ちるので、
 * 残っている値は誰にも観測されないまま次の更新で自然に消える。
 */

/** 廃止済みで、実行時にも載せてはいけないキー。 */
const RETIRED_KEYS = ['callRouteId'] as const;

export function stripRetiredFlowFields<T extends object>(flow: T): T {
  // 大多数のレコードは既に持っていない。無駄なコピーを作らない。
  if (!RETIRED_KEYS.some((k) => k in flow)) return flow;
  const rest: Record<string, unknown> = { ...(flow as Record<string, unknown>) };
  for (const k of RETIRED_KEYS) delete rest[k];
  return rest as T;
}
