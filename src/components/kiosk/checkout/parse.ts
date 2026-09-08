/**
 * 退館フローの応答が**確かめられた形か**を判定する (#1004 増分 2)。
 *
 * ## なぜ型注釈では足りないか
 *
 * `as` は実行時に何も検査しないので、企業プロキシ・API のバージョンスキュー・途中で切れた
 * 本文が返す 200 がそのまま state へ入る。ここは**来訪者導線**なので、増分 1（管理画面）
 * より害が重い:
 *
 * - `{stays}` が欠けた 200 → `setPresent(undefined)` → 次のレンダーの `present.length` が
 *   **TypeError → 退館画面ごと落ちる**（`/kiosk/checkout` に error boundary は無く、
 *   root の `global-error.tsx` が「受付を続けられませんでした」を出す）
 * - `{summary}` が欠けた 200 → `pending.summary.checkedInAt` が throw ――
 *   **退館の確認画面**、つまり来訪者が「退館する」を押す直前で落ちる
 *
 * ## 何を見て、何を見ないか（正直に書く）
 *
 * **見る**のは画面が実際に読むフィールドと、その型。`summary` の `targetLabel` / `purpose` は
 * 画面が `.trim()` を呼ぶので**必須**として扱う（欠けると `summary` ごと欠けるのと同じ害）。
 *
 * **見ない**のは値の妥当性（時刻表記・ラベルの内容）。表示するだけなので、ここで縛ると
 * サーバの表記変更で退館できなくなる。
 *
 * 🔴 **`method` は必須にせず、未知値でも応答を捨てない。** 画面は `data.method ?? method`
 * （要求した手段）でフォールバックするので、サーバが返さなくても正しく動く。しかも
 * `pending.method` は**書かれるだけで一度も読まれない**（独立レビュー 1 周目 MAJOR-1 の実測）。
 * 当初は「省略は許すが未知値なら応答ごと null」にしていたが、それは**消費者ゼロの
 * フィールドで退館導線を止める**設計だった ―― サーバが手段を 1 つ増やした瞬間に
 * QR もコードも全部弾かれて、来訪者が退館できなくなる。未知値は無視する。
 *
 * 🔴 **表示専用のフィールドで導線を止めない。** `summary.targetLabel` / `purpose` は
 * 確認画面に出るだけで、画面側に既定値（「（不明）」）がある。当初は必須にしていたが、
 * 本人性は token またはコード＋ラベル一致で既に立っているので、**ラベルが欠けたことを
 * 理由に退館を止める理由が無い**（`docs/experience/README.md` 原則 5）。空文字へ寄せて
 * 確認画面は出す ―― `.trim()` が throw しないことだけを保証すればよい。
 */
import type { CheckoutMethod, CheckoutSelfIdSummary, PresentStaySummary } from './logic';

const METHODS: readonly CheckoutMethod[] = ['qr', 'code'];

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

/**
 * 省略（`undefined`）と JSON の `null` を同じ「無い」として扱う。
 *
 * 🔴 **`null` を弾かない**（独立レビュー 1 周目 MINOR-3）。今のサーバは `NextResponse.json` が
 * `undefined` キーを落とすので `null` は来ないが、serializer が変わった瞬間に**在館一覧が
 * 丸ごと消える**（QR もコードも失くした来訪者の最後の手段である）。画面側は `?? ''` で
 * 受けているので、通しても壊れない。
 */
function isAbsentOrString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

/**
 * 在館者 1 件。**通れば正規化して返す**（型述語 `value is T` にしない）。
 *
 * 🔴 `isAbsentOrString` は `null` を通すのに `PresentStaySummary` は `targetLabel?: string`
 * なので、型述語のままだと**型が嘘をつく**（独立レビュー 2 周目 MINOR-2）。いまの消費者は
 * どちらも null 安全だが、将来 `=== undefined` で分岐する読み手が現れると `null.trim()` に
 * なる。`asSelfIdSummary` が空文字へ寄せているのと**同じ扱いに揃える**。
 */
function asPresentStay(value: unknown): PresentStaySummary | null {
  if (!isRecord(value)) return null;
  if (typeof value.stayId !== 'string') return null;
  if (typeof value.checkedInAt !== 'string') return null;
  // 一覧の各行に出る。非文字列だと表示が化ける（`targetLabel` は行の主見出し）。
  if (!isAbsentOrString(value.targetLabel)) return null;
  if (!isAbsentOrString(value.purpose)) return null;
  return {
    stayId: value.stayId,
    checkedInAt: value.checkedInAt,
    ...(typeof value.targetLabel === 'string' ? { targetLabel: value.targetLabel } : {}),
    ...(typeof value.purpose === 'string' ? { purpose: value.purpose } : {}),
  };
}

/** `GET /api/kiosk/checkout` の `{ stays }`。形が違えば null（**投げない**）。 */
export function asPresentStayList(value: unknown): PresentStaySummary[] | null {
  if (!isRecord(value)) return null;
  const stays = value.stays;
  // 🔴 **要素まで見る。** `stays: [1,2]` は `.length` を持つので上の検査だけでは素通りし、
  // 行の描画（`s.stayId` を key に使う）で落ちる。
  if (!Array.isArray(stays)) return null;
  const parsed = stays.map(asPresentStay);
  /*
    🔴 **壊れた行だけ落として部分表示する、はしない**（独立レビュー 2 周目 MINOR-4 への回答）。
    レビューは「一覧が丸ごと消えるより部分表示のほうが導線を残せる」と提案したが、採らない。
    この一覧は**staff が来訪者を特定するための照合材料**であって、装飾ではない。3 件中 2 件
    だけ出すのは「その来訪者は在館していない」という**誤った情報**になり、黙って人を取り
    違えさせる。読めなかったことは黙るより出すほうが安全なので、all-or-nothing を選ぶ。
    ―― 一覧が消えても QR / コードの退館導線は残る（`loadPresent` の catch と同じ扱い）。
  */
  if (parsed.some((s) => s === null)) return null;
  return parsed as PresentStaySummary[];
}

/**
 * 確認画面のサマリ。**`checkedInAt` だけが必須**で、他 2 つは空文字へ寄せる。
 *
 * `targetLabel` / `purpose` は画面が `.trim() || tr('checkout.targetUnknown')` で受けるので、
 * 空文字なら「（不明）」と出るだけで**退館は続けられる**。保証すべきは「`.trim()` が
 * throw しないこと」であって、「サーバがラベルを返したこと」ではない。
 */
function asSelfIdSummary(value: unknown): CheckoutSelfIdSummary | null {
  if (!isRecord(value)) return null;
  // 確認画面の主たる判別材料。これが無いと来訪者は「自分の受付か」を確かめられない。
  if (typeof value.checkedInAt !== 'string') return null;
  if (!isAbsentOrString(value.targetLabel)) return null;
  if (!isAbsentOrString(value.purpose)) return null;
  return {
    checkedInAt: value.checkedInAt,
    targetLabel: typeof value.targetLabel === 'string' ? value.targetLabel : '',
    purpose: typeof value.purpose === 'string' ? value.purpose : '',
  };
}

/** `POST /api/kiosk/checkout/resolve` の応答。形が違えば null（**投げない**）。 */
export function asCheckoutResolveResult(
  value: unknown,
): { method: CheckoutMethod | undefined; summary: CheckoutSelfIdSummary } | null {
  if (!isRecord(value)) return null;
  // 未知値は「無かったこと」にする（応答ごと捨てない）。画面が要求手段へフォールバックする。
  const method = METHODS.includes(value.method as CheckoutMethod)
    ? (value.method as CheckoutMethod)
    : undefined;
  const summary = asSelfIdSummary(value.summary);
  if (summary === null) return null;
  return { method, summary };
}
