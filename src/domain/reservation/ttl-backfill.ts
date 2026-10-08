/**
 * 既存の予約レコードへ DynamoDB TTL 属性 `ttl` を後付けする計画（#1022 backfill / PR #1244）。
 *
 * #1244 より前に書かれた予約は `ttl` を持たないので、読み取りからは期限どおり外れても
 * **物理的には残る**。ここはその後付けの「何をするか」だけを決める純関数で、DynamoDB への
 * 読み書きは `src/lib/reservation/ttl-backfill.ts`、実行手順は
 * `docs/runbook-reservation-ttl-backfill.md`（実行は owner・Mac）。
 *
 * ## 規則（`docs/visit-reservation-design.md` の backfill 要件）
 *
 * - `ttl` は `reservationTtlSeconds`（**アプリの書き込みと同じ関数**）で計算し、`now` を使わない。
 *   `now` は「付けた時点で既に期限を過ぎている件数」を報告するためだけに使う。
 * - 🔴 **期限を計算できないレコードを黙って飛ばさない。** 件数と id を報告する。これらは
 *   どの読み取り経路からも返らず、`ttl` も無いので物理削除もされない（「読めず消えない PII」）。
 *   扱いは件数を見て owner が決める。ここでは書き込み対象に入れない（付ける値が無い）。
 * - 既に `ttl` を持つレコードは書き換えない。計算値と一致しないもの（数値でないものを含む）は
 *   件数と id を報告する —— アプリは常に計算値を書くので、食い違いは調べるべき異常である。
 * - どのレコードも区分のどれか 1 つに必ず入る（`toSet + alreadySet + mismatch + uncomputable
 *   = scanned`）。区分から漏れて消えるレコードを作らない。
 *
 * 報告に載せるのは**件数と予約 id だけ**。来訪者の氏名・会社名・メモはそもそも入力に取らない。
 */
import { reservationTtlSeconds } from './retention';

/**
 * 保存済みレコードから、期限の計算に要る属性だけを取り出したもの。DynamoDB の生の値なので
 * 型は信用しない（`unknown`）。
 */
export type StoredReservationRetentionFields = {
  readonly id: string;
  readonly visitAt?: unknown;
  readonly expiresAt?: unknown;
  readonly retentionDays?: unknown;
  readonly ttl?: unknown;
};

export type TtlBackfillAction = { readonly id: string; readonly ttl: number };

export type TtlBackfillSummary = {
  /** 走査した件数。 */
  readonly scanned: number;
  /** `ttl` を後付けする件数。 */
  readonly toSet: number;
  /** そのうち、付ける `ttl` が既に `now` 以前のもの（付けた時点で TTL 削除の対象になる）。 */
  readonly toSetAlreadyExpired: number;
  /** 計算値と一致する `ttl` を既に持つ件数（何もしない）。 */
  readonly alreadySet: number;
  /** 計算値と違う `ttl` を持つ件数（書き換えない・報告する）。 */
  readonly mismatch: number;
  /** 期限を計算できない件数（書き換えない・報告する）。 */
  readonly uncomputable: number;
};

export type TtlBackfillPlan = {
  readonly actions: readonly TtlBackfillAction[];
  readonly uncomputableIds: readonly string[];
  readonly mismatchIds: readonly string[];
  readonly summary: TtlBackfillSummary;
};

export function planReservationTtlBackfill(
  rows: readonly StoredReservationRetentionFields[],
  nowMs: number,
): TtlBackfillPlan {
  const actions: TtlBackfillAction[] = [];
  const uncomputableIds: string[] = [];
  const mismatchIds: string[] = [];
  let alreadySet = 0;
  let toSetAlreadyExpired = 0;

  for (const row of rows) {
    // 読み取り側（`isReservationRetainedAt`）と同じ関数へ、保存値をそのまま渡す。型を正すと
    // アプリと違う解釈になりうる（アプリも保存値を検証せずにこの関数へ渡している）。
    const ttl = reservationTtlSeconds(row as Parameters<typeof reservationTtlSeconds>[0]);
    if (ttl === undefined) {
      uncomputableIds.push(row.id);
    } else if (row.ttl === undefined) {
      actions.push({ id: row.id, ttl });
      if (ttl * 1000 <= nowMs) toSetAlreadyExpired += 1;
    } else if (row.ttl === ttl) {
      alreadySet += 1;
    } else {
      mismatchIds.push(row.id);
    }
  }

  return {
    actions,
    uncomputableIds,
    mismatchIds,
    summary: {
      scanned: rows.length,
      toSet: actions.length,
      toSetAlreadyExpired,
      alreadySet,
      mismatch: mismatchIds.length,
      uncomputable: uncomputableIds.length,
    },
  };
}
