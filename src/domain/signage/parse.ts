/**
 * サイネージ設定の応答が**確かめられた形か**を判定する (#1004)。
 *
 * ## なぜ型注釈では足りないか
 *
 * `setConfig((await res.json()) as SignageConfig)` の `as` は**実行時に何も検査しない**。
 * 企業プロキシ・API のバージョンスキュー・途中で切れた本文が `200 {"ok":true}` を返すと、
 * それがそのまま state に入り、**次のレンダーで `config.items.map` が TypeError を投げて
 * `/admin/signage` が画面ごと落ちる**（`src/app/admin` 配下に error boundary は無い）。
 *
 * #973 増分 02 が `SecurityManager` へ入れた「**確かめられた 200 だけを成功と呼ぶ**」を、
 * この画面へ広げる。読めなかった 200 と同じく `unreadable` として扱う ―― 届いてはいるので
 * 通信を疑わせない、が要点（`src/components/admin/ui/save-outcome.ts`）。
 *
 * ## 何を見て、何を見ないか（正直に書く）
 *
 * **見る**のは「この設定を画面が壊れずに描けるか」を決めるフィールド ―― 必須フィールドの
 * 存在と型、`items` が配列であること、その**要素**が項目の形をしていること。
 *
 * **見ない**のは値の妥当性（秒数の範囲・URL の到達性・type ごとの必須フィールドの整合）。
 * そこは保存時にサーバが検証する領域で、ここで二重に持つと**写しがズレる**。
 * ここが答えるのは「載せてよいか」だけである。
 */
import { isSignageContentType, type SignageConfig, type SignageItem } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSignageItem(value: unknown): value is SignageItem {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string') return false;
  if (!isSignageContentType(value.type)) return false;
  if (typeof value.enabled !== 'boolean') return false;
  return true;
}

/** 応答が `SignageConfig` の形なら返す。違えば null（**投げない**）。 */
export function asSignageConfig(value: unknown): SignageConfig | null {
  if (!isRecord(value)) return null;
  if (typeof value.tenantId !== 'string') return null;
  if (typeof value.siteId !== 'string') return null;
  if (typeof value.enabled !== 'boolean') return null;
  if (typeof value.defaultIntervalSeconds !== 'number') return null;
  if (typeof value.updatedAt !== 'string') return null;
  // 🔴 要素まで見る。`items.map` が落ちる形を通さないのがこの述語の主目的である。
  if (!Array.isArray(value.items) || !value.items.every(isSignageItem)) return null;
  return value as unknown as SignageConfig;
}
