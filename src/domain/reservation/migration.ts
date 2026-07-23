/**
 * 予約トークンの hash 化移行 (#375)。
 *
 * #97 時点の永続レコード（`LegacyVisitReservation`）は来訪者トークンを**平文**で保持していた。
 * #375 では生 token を保存せず一方向 hash（`tokenHash`）のみを保存する。本モジュールは
 * 既存レコードを新形へ変換する純関数を提供する。
 *
 * 移行戦略（**一括移行 / batch**を採用。dual-read は採らない）:
 *   - 永続ストア導入時（#97 increment 3・DynamoDB）に、既存レコードを読み出して
 *     `migrateReservationToHashed` で tokenHash へ変換し、平文 token を落として書き戻す。
 *   - 照合経路（findByTokenHash）は常に tokenHash のみを見る単一経路に保つ。query 時に
 *     「平文とも突き合わせる」dual-read を残すと、未移行レコードの平文照合が生き続け、
 *     「生 token を保存しない」不変条件を弱める（＝平文がストアに残り得る）。一括移行なら
 *     移行完了後にストアへ平文が一切残らないことを保証できる。
 *   - 現状の永続化は in-memory のみ（本番 DynamoDB 実装は未着手＝移行対象の実データは無い）。
 *     本関数は永続化増分が入る際の前方互換ユーティリティであり、テストで移行経路を固定する。
 */
import { hashReservationToken } from './token';
import type { LegacyVisitReservation, VisitReservation } from './types';

/**
 * 平文 token を持つ旧レコードを、tokenHash のみを持つ新レコードへ変換する。
 * 生 token は結果から取り除く（ストアへ平文を残さない）。
 */
export function migrateReservationToHashed(
  legacy: LegacyVisitReservation,
  pepper = '',
): VisitReservation {
  const { token, ...rest } = legacy;
  return {
    ...rest,
    tokenHash: hashReservationToken(token, pepper),
  };
}
