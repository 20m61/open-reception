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
 * 純関数のみ。時刻は呼び出し側が渡す。
 */
import type { VisitReservation } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** `retentionDays` が欠落・不正な旧レコード向けの既定値（作成リクエストの既定と同じ）。 */
export const DEFAULT_RESERVATION_RETENTION_DAYS = 30;

type RetentionFields = Pick<VisitReservation, 'visitAt' | 'expiresAt' | 'retentionDays'>;

function effectiveRetentionDays(days: unknown): number {
  return typeof days === 'number' && Number.isInteger(days) && days > 0
    ? days
    : DEFAULT_RESERVATION_RETENTION_DAYS;
}

/**
 * 保存期限の時刻（epoch ミリ秒）。この時刻**以降**は保持しない。
 * 日付が解釈できない場合は NaN（呼び出し側は「保持を証明できない」として扱う）。
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
  return now.getTime() < reservationRetentionDeadlineMs(r);
}

/**
 * DynamoDB TTL 属性値（epoch 秒）。期限を秒へ**切り上げる**ので、物理削除が読み取り側の
 * 期限より先に起きることはない（遅れは 1 秒未満）。期限を計算できない場合は undefined
 * （TTL を付けない。読み取り側は保持しないので露出はしない）。
 */
export function reservationTtlSeconds(r: RetentionFields): number | undefined {
  const deadline = reservationRetentionDeadlineMs(r);
  return Number.isFinite(deadline) ? Math.ceil(deadline / 1000) : undefined;
}
