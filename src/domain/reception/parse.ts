/**
 * 受付作成の応答が**確かめられた形か**を判定する (#1004 増分 2)。
 *
 * ## なぜ型注釈では足りないか
 *
 * `(await createRes.json()) as { id: string }` の `as` は実行時に何も検査しない。
 * `id` が欠けた 200 が返ると、その `undefined` が**そのまま 2 か所へ流れる** ――
 * 状態機械（`SESSION_CREATED`）と URL（`/api/kiosk/receptions/undefined/call`）である。
 *
 * ## 何を見て、何を見ないか（正直に書く）
 *
 * **見る**のは `id` だけ。それが**この応答から実際に使う唯一の値**だからである
 * （呼び出しの URL と状態機械へ渡す ID）。サーバは `state` 等も返すが、端末はこの時点で
 * 読まない ―― 見ない値を必須にすると、サーバがフィールドを整理したときに
 * **受付できなくなる**（互換の向きが逆になる）。
 *
 * 🔴 **述語で防げないもの**: `id` が読めなかったとき、受付レコードは**サーバ側に既に
 * 存在する**（作成の POST は 200 を返している）。端末はその ID を知らないので、
 * **呼ぶことも・完了することも・取り消すこともできない**。この孤児は述語では防げない
 * ―― ID を知らないものは取り消しようがないので、サーバ側の TTL/掃除の領分である。
 * ここが担うのは「これ以上悪化させない」（嘘の理由を出さない、`/undefined/call` を
 * 叩かない）ことだけである。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 受付作成の応答が使える形なら `{ id }` を返す。違えば null（**投げない**）。 */
export function asCreatedReception(value: unknown): { id: string } | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  if (typeof id !== 'string') return null;
  /*
    🔴 **空文字・空白のみも弾く。** 型としては `string` なので素通りするが、URL へ入れると
    `/api/kiosk/receptions//call` になってパスが 1 つ潰れ、`undefined` とは**別の**経路で
    壊れる（`shouldOpenVideoView` が `trim().length > 0` を見ているのと同じ理由）。
  */
  if (id.trim().length === 0) return null;
  return { id };
}
