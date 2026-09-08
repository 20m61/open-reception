/**
 * 営業時間ポリシーの応答が**確かめられた形か**を判定する (#1004)。
 *
 * ## なぜ型注釈では足りないか
 *
 * `(await res.json()) as { policy: PolicyView }` の `as` は実行時に何も検査しない。
 * `policy` が欠けた 200 が返ると `applyPolicy(undefined)` が走り、**フォームが黙って
 * 既定値へ初期化される**（＝運用者の編集が消える）。さらに `setPolicy(undefined)` で
 * 以後の保存から `expectedVersion` が落ちるので、**#367 の楽観ロックが外れる** ――
 * 同時編集の後勝ちがサーバ側で 409 にならなくなる。そのうえで画面は「保存しました」と出す。
 *
 * ## 何を見て、何を見ないか（正直に書く）
 *
 * **見る**のは必須フィールドの存在と型、および配列の**要素**の形。とくに `version` は
 * 楽観ロックの要なので、数値であることを必ず見る。
 *
 * **見ない**のは値の妥当性（時刻表記・日付表記・タイムゾーン名の実在）。そこは保存時に
 * サーバが検証する領域で、ここで二重に持つと写しがズレる。
 */
import type { OperatingException, ServiceOperatingPolicy, TimeRange } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimeRange(value: unknown): value is TimeRange {
  return isRecord(value) && typeof value.start === 'string' && typeof value.end === 'string';
}

function isOperatingException(value: unknown): value is OperatingException {
  if (!isRecord(value)) return false;
  if (typeof value.date !== 'string') return false;
  if (typeof value.closed !== 'boolean') return false;
  if (value.ranges !== undefined && (!Array.isArray(value.ranges) || !value.ranges.every(isTimeRange))) {
    return false;
  }
  return true;
}

/** 応答が `ServiceOperatingPolicy` の形なら返す。違えば null（**投げない**）。 */
export function asServiceOperatingPolicy(value: unknown): ServiceOperatingPolicy | null {
  if (!isRecord(value)) return null;
  if (typeof value.tenantId !== 'string') return null;
  if (typeof value.siteId !== 'string') return null;
  if (typeof value.timezone !== 'string') return null;
  if (typeof value.updatedAt !== 'string') return null;
  if (typeof value.updatedBy !== 'string') return null;
  // 🔴 楽観ロックの要。文字列の "3" を通すと `expectedVersion` に載って後勝ち検出が壊れる。
  if (typeof value.version !== 'number') return null;
  /*
    🔴 **値まで見る。** キーの存在だけ見て通すと `{ mon: { start, end } }`（配列でない）が
    素通りし、`formatTimeRanges` の `ranges.map` が throw する。`load()` は `void load()` で
    呼ばれているので**未処理 rejection** になり、`setLoadedScopeKey` へ到達しない ――
    画面は「読み込み中…」のまま止まり、**その枝には再試行ボタンが無い**（独立レビュー MAJOR-1）。
    この増分がサイネージで潰したのと同じ「画面が使えなくなる」害である。
  */
  if (!isRecord(value.weeklySchedule)) return null;
  for (const ranges of Object.values(value.weeklySchedule)) {
    if (!Array.isArray(ranges) || !ranges.every(isTimeRange)) return null;
  }
  if (!Array.isArray(value.fixedHolidays) || !value.fixedHolidays.every((d) => typeof d === 'string')) {
    return null;
  }
  if (!Array.isArray(value.exceptionDates) || !value.exceptionDates.every(isOperatingException)) {
    return null;
  }
  return value as unknown as ServiceOperatingPolicy;
}

/**
 * `GET/PUT /api/admin/operating-policy` の封筒 `{ policy }`。
 *
 * 🔴 **`policy: null` は正当**（そのサイトにまだ設定が無い＝未設定）。だが**キーごと
 * 欠けている**のは別物で、それが `applyPolicy(undefined)` を呼んでフォームを黙って
 * 初期化し、`expectedVersion` を落としていた当の形である。両者を混同しない。
 */
export function asOperatingPolicyResponse(
  value: unknown,
): { policy: ServiceOperatingPolicy | null } | null {
  if (!isRecord(value)) return null;
  // `policy` が無い／`undefined` は下の `asServiceOperatingPolicy` が弾く。
  // ここで `'policy' in value` を重ねても結果は変わらないので置かない（読み手に
  // 「この行が効いている」と誤読させるだけ ―― 変異検証で等価と確認済み）。
  if (value.policy === null) return { policy: null };
  const policy = asServiceOperatingPolicy(value.policy);
  return policy === null ? null : { policy };
}

/**
 * **保存の**応答。`policy: null` を通さない。
 *
 * 🔴 GET では `policy: null` が正当（そのサイトは未設定）だが、**PUT の応答に null はあり得ない**
 * （`src/app/api/admin/operating-policy/route.ts` は必ず更新後の値を返す）。共用すると、
 * `{"policy":null}` な 200 で `applyPolicy(null)` が走り、画面が「まだ設定がありません」へ化けた
 * うえで「保存しました」を出す。次の保存は `expectedVersion` を落とすのでサーバが 409 を返し、
 * 画面は「ほかの管理者が更新済み」という**嘘**を出す（独立レビュー MAJOR-4）。
 */
export function asSavedOperatingPolicyResponse(value: unknown): ServiceOperatingPolicy | null {
  const parsed = asOperatingPolicyResponse(value);
  return parsed === null ? null : parsed.policy;
}
