/**
 * 既存の予約レコードへ `ttl` を後付けする backfill の DynamoDB 入出力（#1022 / PR #1244）。
 *
 * 何をするかの規則は `@/domain/reservation/ttl-backfill`（純関数）、実行手順は
 * `docs/runbook-reservation-ttl-backfill.md`、CLI は `scripts/reservation-ttl-backfill.ts`。
 * **本番データ操作なので実行は owner（Mac の端末）だけ。** Claude のセッションからは
 * MiniStack に対してしか回さない。
 *
 * ## 安全側の作り
 *
 * - **既定は dry-run。** `apply` を渡さない限り Query 以外のコマンドを送らない。
 * - `apply` は dry-run で見た `toSet` 件数（`expectedToSet`）を要求し、走査し直した件数と
 *   違えば **1 件も書かずに止まる**。owner が見た計画と違うものを書かない。
 * - 書き込みは `ttl` だけを足す `UpdateItem`。アイテム全体を置き換えないので、他の属性を
 *   古い値で上書きしない。条件は「まだ在る・まだ `ttl` が無い・期限の計算に使った属性
 *   （`visitAt` / `expiresAt` / `retentionDays`）が走査時と同じ」。走査後にアプリが書いた
 *   （＝自分で `ttl` を載せた）・編集された・消えたレコードは上書きせず `skippedChanged` に数える。
 *   条件があるので**何度流しても同じ結果**になる（途中で止まったら流し直せばよい）。
 * - 走査は `ProjectionExpression` で期限の計算に要る属性だけを読む。来訪者の氏名・会社名・
 *   メモは読み出さない。報告に載るのは件数と予約 id だけ。
 * - 走査は予約のパーティション（`col#visit_reservation`）を**最後のページまで**読む。
 *   アプリの `list` の 1000 件上限は使わない（上限で切ると残りが backfill から漏れる）。
 */
import { QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  planReservationTtlBackfill,
  type StoredReservationRetentionFields,
  type TtlBackfillPlan,
} from '@/domain/reservation/ttl-backfill';
import { RESERVATION_COLLECTION } from './data-backed-repository';

const PARTITION = `col#${RESERVATION_COLLECTION}`;

type Item = Record<string, unknown>;

/** dry-run の件数と、走査し直した件数が違う。1 件も書いていない。 */
export class TtlBackfillAbortedError extends Error {
  constructor(expected: number, actual: number) {
    super(
      `toSet changed since the dry-run (expected ${expected}, now ${actual}); nothing was written. ` +
        'Run the dry-run again and review the new plan.',
    );
    this.name = 'TtlBackfillAbortedError';
  }
}

export type TtlBackfillReport =
  | { readonly mode: 'dry-run'; readonly plan: TtlBackfillPlan }
  | {
      readonly mode: 'apply';
      readonly plan: TtlBackfillPlan;
      readonly applied: { readonly updated: number; readonly skippedChanged: number };
      readonly skippedChangedIds: readonly string[];
    };

export type RunTtlBackfillOptions = {
  readonly doc: Pick<DynamoDBDocumentClient, 'send'>;
  readonly table: string;
  /** 「付けた時点で既に期限を過ぎている件数」の報告にだけ使う。`ttl` の値には入らない。 */
  readonly nowMs: number;
  /** 渡したときだけ書き込む。`expectedToSet` は dry-run で見た `toSet`。 */
  readonly apply?: { readonly expectedToSet: number };
};

async function scan(
  doc: RunTtlBackfillOptions['doc'],
  table: string,
): Promise<StoredReservationRetentionFields[]> {
  const rows: StoredReservationRetentionFields[] = [];
  let start: Item | undefined;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': PARTITION },
        ProjectionExpression: '#sk, #visitAt, #expiresAt, #retentionDays, #ttl',
        ExpressionAttributeNames: {
          '#sk': 'SK',
          '#visitAt': 'visitAt',
          '#expiresAt': 'expiresAt',
          '#retentionDays': 'retentionDays',
          '#ttl': 'ttl',
        },
        ConsistentRead: true,
        ExclusiveStartKey: start,
      }),
    );
    for (const item of (res.Items as Item[] | undefined) ?? []) {
      rows.push({
        id: String(item.SK),
        visitAt: item.visitAt,
        expiresAt: item.expiresAt,
        retentionDays: item.retentionDays,
        ttl: item.ttl,
      });
    }
    start = res.LastEvaluatedKey as Item | undefined;
  } while (start);
  return rows;
}

/** 走査時の値と同じであること（無かったものは今も無いこと）を条件にする。 */
function unchangedSinceScan(row: StoredReservationRetentionFields): {
  conds: string[];
  names: Record<string, string>;
  values: Item;
} {
  const conds = ['attribute_exists(#pk)', 'attribute_not_exists(#ttl)'];
  const names: Record<string, string> = { '#pk': 'PK', '#ttl': 'ttl' };
  const values: Item = {};
  for (const field of ['visitAt', 'expiresAt', 'retentionDays'] as const) {
    const nm = `#${field}`;
    names[nm] = field;
    const v = row[field];
    if (v === undefined) {
      conds.push(`attribute_not_exists(${nm})`);
    } else {
      values[`:${field}`] = v;
      conds.push(`${nm} = :${field}`);
    }
  }
  return { conds, names, values };
}

export async function runReservationTtlBackfill(
  options: RunTtlBackfillOptions,
): Promise<TtlBackfillReport> {
  const { doc, table, nowMs, apply } = options;
  const rows = await scan(doc, table);
  const plan = planReservationTtlBackfill(rows, nowMs);
  if (!apply) return { mode: 'dry-run', plan };

  if (plan.summary.toSet !== apply.expectedToSet) {
    throw new TtlBackfillAbortedError(apply.expectedToSet, plan.summary.toSet);
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  let updated = 0;
  const skippedChangedIds: string[] = [];
  for (const action of plan.actions) {
    const { conds, names, values } = unchangedSinceScan(byId.get(action.id)!);
    try {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { PK: PARTITION, SK: action.id },
          UpdateExpression: 'SET #ttl = :ttl',
          ConditionExpression: conds.join(' AND '),
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: { ...values, ':ttl': action.ttl },
        }),
      );
      updated += 1;
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        skippedChangedIds.push(action.id);
        continue;
      }
      // 握り潰さない。条件付きなので、原因を除いてから流し直せば続きから同じ結果になる。
      throw new Error(
        `backfill stopped: updated ${updated}, skippedChanged ${skippedChangedIds.length}, ` +
          `failed at reservation ${action.id}: ${(err as Error).message}. Re-running is safe.`,
        { cause: err },
      );
    }
  }
  return {
    mode: 'apply',
    plan,
    applied: { updated, skippedChanged: skippedChangedIds.length },
    skippedChangedIds,
  };
}
