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
 * 叩かない）ことだけである。孤児は `DEFAULT_RECEPTION_TTL_SEC`（24h。
 * `src/lib/data-stores/reception-repository.ts`）で消える ―― 無限には残らない。
 */

/*
  🔴 **`!Array.isArray` は、この 2 モジュールでは現在「等価」である**（実測。#1004 増分 2）。
  JSON は配列に名前付きプロパティを載せられないので、配列を渡してもフィールド読みは全部
  `undefined` になり、後続の型検査が必ず落とす ―― つまりこの行を消しても結果は変わらず、
  **変異を当てても kill されない**。それでも残すのは 2 つの理由による:
    1. 増分 1 の `signage/parse.ts` / `operating-policy/parse.ts` では**この行は効いている**
       （`weeklySchedule` のように「オブジェクトであること」自体を要求する枝がある）。
       4 つの写しで挙動を揃えておかないと、読み手がどれを信じてよいか分からなくなる
    2. `Array.isArray` を使う枝をこのモジュールに足した瞬間、**この行は効き始める**
  「テストで縛られている」とは言えないことを、ここに書いておく（覆われている錯覚を作らない）。
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

/**
 * 呼び出し `POST /api/kiosk/receptions/{id}/call` の応答 (#1004 増分 2、独立レビュー 1 周目 MAJOR-3)。
 *
 * 🔴 **当初これは「実害なし・対応不要」と判定していた。誤りだった。**
 * 下流（`parseCallStages` は `unknown` 安全、`shouldOpenVideoView` は型検査あり、`state` 不一致は
 * else で `CALL_FAILED`）だけを見て、**`res.json()` 自身が throw する経路を見落としていた**。
 * `200 text/html` や `200 null` が返ると `.json()` または `result.error` の読みが throw し、
 * 外側の catch が `CALL_FAILED reason: 'network'` を出す。そして
 * `shouldOfferAlternativeContact('network') === false` なので、
 * **来訪者の画面からボタンが 1 つも無くなる**（レビューの実測）。
 * 受付作成側で直したのと同じ「理由が嘘になる」害が、**より重い形**で残っていた。
 *
 * ## 何を見て、何を見ないか
 *
 * **見る**のは「オブジェクトであること」と、読む 2 フィールドの型だけ。
 *
 * 🔴 **`state` を必須にしない。** 営業時間外の 409 は `{ error, reason, reopenAt }` を返し、
 * `state` を持たない ―― 必須にすると**閉店後の来訪者向けの正しい案内を弾く**
 * （`kiosk-out-of-hours-call.spec.ts` が固定している経路）。
 */
export type CallResult = Record<string, unknown> & {
  state?: string;
  error?: string;
  vonageSessionId?: string | null;
};

export function asCallResult(value: unknown): CallResult | null {
  if (!isRecord(value)) return null;
  // 呼び出し側が読む 3 つだけを見る。**戻り値の型で保証する**ので、呼び出し側に `as` を
  // 残さない（独立レビュー 2 周目 MINOR-3。`as` を消すのが目的の増分で `as` を残さない）。
  if (value.error !== undefined && typeof value.error !== 'string') return null;
  if (value.state !== undefined && typeof value.state !== 'string') return null;
  // PSTN 発信では付かない（`shouldOpenVideoView` が `trim()` を呼ぶ）。
  if (
    value.vonageSessionId !== undefined &&
    value.vonageSessionId !== null &&
    typeof value.vonageSessionId !== 'string'
  ) {
    return null;
  }
  return value as CallResult;
}
