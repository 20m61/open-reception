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
 * 🔴 **`method` は必須にしない。** 画面は `data.method ?? method`（要求した手段）で
 * フォールバックしており、サーバが返さなくても正しく動く。必須にすると、今まで動いていた
 * 応答を弾いて**来訪者が退館できなくなる** ―― 述語の偽陽性が導線を止める側の典型である。
 */
import type { CheckoutMethod, CheckoutSelfIdSummary, PresentStaySummary } from './logic';

const METHODS: readonly CheckoutMethod[] = ['qr', 'code'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isPresentStay(value: unknown): value is PresentStaySummary {
  if (!isRecord(value)) return false;
  if (typeof value.stayId !== 'string') return false;
  if (typeof value.checkedInAt !== 'string') return false;
  // 一覧の各行に出る。非文字列だと表示が化ける（`targetLabel` は行の主見出し）。
  if (!isOptionalString(value.targetLabel)) return false;
  if (!isOptionalString(value.purpose)) return false;
  return true;
}

/** `GET /api/kiosk/checkout` の `{ stays }`。形が違えば null（**投げない**）。 */
export function asPresentStayList(value: unknown): PresentStaySummary[] | null {
  if (!isRecord(value)) return null;
  const stays = value.stays;
  // 🔴 **要素まで見る。** `stays: [1,2]` は `.length` を持つので上の検査だけでは素通りし、
  // 行の描画（`s.stayId` を key に使う）で落ちる。
  if (!Array.isArray(stays) || !stays.every(isPresentStay)) return null;
  return stays as PresentStaySummary[];
}

function isSelfIdSummary(value: unknown): value is CheckoutSelfIdSummary {
  if (!isRecord(value)) return false;
  // 3 つとも画面が読む。`targetLabel` / `purpose` は `.trim()` を呼ぶので欠けると throw する。
  if (typeof value.checkedInAt !== 'string') return false;
  if (typeof value.targetLabel !== 'string') return false;
  if (typeof value.purpose !== 'string') return false;
  return true;
}

/** `POST /api/kiosk/checkout/resolve` の応答。形が違えば null（**投げない**）。 */
export function asCheckoutResolveResult(
  value: unknown,
): { method: CheckoutMethod | undefined; summary: CheckoutSelfIdSummary } | null {
  if (!isRecord(value)) return null;
  const method = value.method;
  // 省略は正当（画面が要求した手段へフォールバックする）。あるなら語彙内であること。
  if (method !== undefined && !METHODS.includes(method as CheckoutMethod)) return null;
  if (!isSelfIdSummary(value.summary)) return null;
  return { method: method as CheckoutMethod | undefined, summary: value.summary };
}
