/**
 * 予約 PII の保存期間 (#1022)。
 *
 * 予約レコード（来訪者氏名・会社名・メモ）は、**来訪の終わり**を起点に `retentionDays` 日で
 * 破棄する。起点は `max(visitAt, expiresAt)` —— 予定来訪日時とトークン有効期限の遅い方。
 * 作成日時や更新日時を起点にしない（先の日付で作った予約が、来訪より前に消えてしまう）。
 *
 * 破棄は 2 段で成立させる:
 *   1. 書き込み時に DynamoDB TTL 属性（`ttl`、epoch 秒）を起点から計算して載せる（物理削除）。
 *   2. 読み取り時に起点を過ぎたレコードを返さない。DynamoDB の TTL 削除は遅延する
 *      （最大で 48 時間程度）ため、1 だけでは期限後もしばらく読めてしまう。
 *
 * 読み取り側の判定はレコードの業務フィールドから毎回計算する。`ttl` 属性を持たない旧レコード
 * （本変更より前に書かれたもの）も同じ規則で判定されるので、読み取りの既定値は不要になる。
 *
 * ## 計算できない期限は「保持しない」へ倒す（fail-closed）
 *
 * 期限が有限の数として求まらない入力（解釈できない日付、`retentionDays` が正の安全整数でない、
 * 積が非有限になるほど大きい、`now` 自体が不正）は、**どの関数でも保持しない側**に倒す:
 *   - `reservationRetentionDeadlineMs` は NaN を返す（±Infinity を返さない）
 *   - `isReservationRetainedAt` は false（読み取り経路から外れる）
 *   - `reservationTtlSeconds` は undefined（書き込み側はこれを見て**書き込みを拒否する**。
 *     読めない PII を物理削除の当てなく残さないため）
 * 「期限を計算できる ⟺ 保持しうる ⟺ TTL が付く」が 1 つの条件（有限の期限）で揃うので、
 * 読める予約は必ず書き戻せ、書けた予約は必ず TTL を持つ。
 *
 * `retentionDays` の**欠落**だけは既定値で補う（属性を持たない旧レコードの互換）。値があるのに
 * 不正な場合は既定値で補わない —— 既定（30 日）は入力値より長いことがあり、保持を延ばす側へ倒れる。
 *
 * 純関数のみ。時刻は呼び出し側が渡す。
 */
import type { VisitReservation } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** `retentionDays` を持たない旧レコード向けの既定値（作成リクエストの既定と同じ）。 */
export const DEFAULT_RESERVATION_RETENTION_DAYS = 30;

type RetentionFields = Pick<VisitReservation, 'visitAt' | 'expiresAt' | 'retentionDays'>;

/** 欠落は既定値、正の安全整数はそのまま、それ以外は NaN（期限を計算できない）。 */
function effectiveRetentionDays(days: unknown): number {
  if (days === undefined) return DEFAULT_RESERVATION_RETENTION_DAYS;
  return typeof days === 'number' && Number.isSafeInteger(days) && days > 0 ? days : Number.NaN;
}

/**
 * 保存期限の時刻（epoch ミリ秒）。この時刻**以降**は保持しない。
 * 期限を計算できない場合は NaN。±Infinity にはならない —— `Date.parse` は有限か NaN しか
 * 返さず、日数を**安全整数**に限っているので積も有限に収まる（`isInteger` に緩めると
 * `1e308` 日で +Infinity になり「永久に保持・TTL なし」へ倒れる。テストが縛る）。
 */
export function reservationRetentionDeadlineMs(r: RetentionFields): number {
  const end = Math.max(Date.parse(r.visitAt), Date.parse(r.expiresAt));
  return end + effectiveRetentionDays(r.retentionDays) * DAY_MS;
}

/**
 * `now` の時点でまだ保持してよいか。期限を過ぎた、または期限を計算できないレコードは
 * 保持しない（PII を残す側へ倒さない）。
 */
export function isReservationRetainedAt(r: RetentionFields, now: Date): boolean {
  // 期限が NaN、または `now` が Invalid Date（getTime() が NaN）なら比較は false = 保持しない。
  return now.getTime() < reservationRetentionDeadlineMs(r);
}

/**
 * DynamoDB TTL 属性値（epoch 秒）。期限を秒へ**切り上げる**ので、物理削除が読み取り側の
 * 期限より先に起きることはない（遅れは 1 秒未満）。期限を計算できない場合は undefined
 * （呼び出し側はそのレコードを**書かない**。読み取り側も保持しないので、書いても読めない PII が
 * 物理削除の当てなく残るだけになる）。
 */
export function reservationTtlSeconds(r: RetentionFields): number | undefined {
  const deadline = reservationRetentionDeadlineMs(r);
  return Number.isFinite(deadline) ? Math.ceil(deadline / 1000) : undefined;
}
