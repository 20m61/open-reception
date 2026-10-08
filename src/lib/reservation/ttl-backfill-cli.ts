/**
 * 予約 `ttl` backfill の CLI（#1022 / PR #1244）。手順は `docs/runbook-reservation-ttl-backfill.md`。
 *
 *     # dry-run（既定。書き込まない）
 *     npx tsx src/lib/reservation/ttl-backfill-cli.ts --table <DataTableName>
 *     # apply（dry-run で見た toSet の件数を渡す。違えば 1 件も書かずに止まる）
 *     npx tsx src/lib/reservation/ttl-backfill-cli.ts --table <DataTableName> --apply --expect-to-set <N>
 *
 * 向き先（実 AWS / エミュレータ）・region・資格情報は `awsClientConfig()`（ADR 0010）が
 * 解決する。`AWS_RUNTIME` が無ければ実 AWS。**本番データ操作なので apply は owner が Mac で
 * 回す。** Claude のセッションからは `AWS_RUNTIME=ministack` でしか回さない。
 *
 * `scripts/` ではなくここに置いているのは、`scripts/` へ置くと共有ファイル
 * （`package.json` か `scripts/check-script-wiring.ts` の手動実行リスト）への登録が要るため。
 *
 * 終了コード: 0 = 完了 / 1 = 実行時エラー / 2 = 引数の誤り / 3 = dry-run 後に件数が変わった（未書き込み）。
 */
import { pathToFileURL } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { awsClientConfig } from '@/lib/aws/client-config';
import { resolveAwsRuntime } from '@/domain/governance/aws-runtime';
import {
  runReservationTtlBackfill,
  TtlBackfillAbortedError,
  type TtlBackfillReport,
} from './ttl-backfill';

export type TtlBackfillArgs = {
  readonly table: string;
  readonly apply?: { readonly expectedToSet: number };
  readonly json: boolean;
};

export class TtlBackfillUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TtlBackfillUsageError';
  }
}

const USAGE =
  'usage: npx tsx src/lib/reservation/ttl-backfill-cli.ts --table <name> ' +
  '[--apply --expect-to-set <N>] [--json]';

export function parseTtlBackfillArgs(argv: readonly string[]): TtlBackfillArgs {
  let table: string | undefined;
  let apply = false;
  let expect: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--table') table = argv[++i];
    else if (a === '--apply') apply = true;
    else if (a === '--expect-to-set') expect = argv[++i];
    else if (a === '--json') json = true;
    else throw new TtlBackfillUsageError(`unknown argument: ${a}\n${USAGE}`);
  }
  if (!table) throw new TtlBackfillUsageError(`--table is required\n${USAGE}`);
  if (!apply) {
    if (expect !== undefined) {
      throw new TtlBackfillUsageError(`--expect-to-set is only valid with --apply\n${USAGE}`);
    }
    return { table, json };
  }
  // 🔴 apply は dry-run で見た件数を必須にする（見ていない計画を書かない）。
  if (expect === undefined || !/^\d+$/.test(expect)) {
    throw new TtlBackfillUsageError(
      `--apply requires --expect-to-set <N> (the toSet count from the dry-run)\n${USAGE}`,
    );
  }
  return { table, apply: { expectedToSet: Number(expect) }, json };
}

/** 人が読む報告。件数と予約 id だけを出す（来訪者の情報は読み出してもいない）。 */
export function formatTtlBackfillReport(report: TtlBackfillReport): string {
  const s = report.plan.summary;
  const lines = [
    `mode: ${report.mode}`,
    `scanned: ${s.scanned}`,
    `toSet: ${s.toSet}  (already expired when set: ${s.toSetAlreadyExpired})`,
    `alreadySet: ${s.alreadySet}`,
    `mismatch: ${s.mismatch}`,
    `uncomputable: ${s.uncomputable}`,
  ];
  if (report.mode === 'apply') {
    lines.push(
      `updated: ${report.applied.updated}`,
      `skippedChanged: ${report.applied.skippedChanged}`,
    );
    for (const id of report.skippedChangedIds) lines.push(`  skippedChanged id: ${id}`);
  }
  // 🔴 黙って飛ばさない（review2 MINOR-2）。0 件でも行を出す。
  for (const id of report.plan.uncomputableIds) lines.push(`  uncomputable id: ${id}`);
  for (const id of report.plan.mismatchIds) lines.push(`  mismatch id: ${id}`);
  if (s.uncomputable > 0 || s.mismatch > 0) {
    lines.push(
      'ACTION NEEDED: uncomputable / mismatch rows were not changed. ' +
        'Decide how to handle them (see the runbook, step 5).',
    );
  }
  return lines.join('\n');
}

async function main(argv: readonly string[]): Promise<number> {
  let args: TtlBackfillArgs;
  try {
    args = parseTtlBackfillArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  const config = awsClientConfig();
  // 向き先を最初に出す（どのテーブルへ書くかを owner が目で確かめられるように）。
  console.error(
    `target: runtime=${resolveAwsRuntime(process.env)} region=${config.region} table=${args.table}`,
  );
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient(config));
  try {
    const report = await runReservationTtlBackfill({
      doc,
      table: args.table,
      nowMs: Date.now(),
      apply: args.apply,
    });
    console.log(args.json ? JSON.stringify(report, null, 2) : formatTtlBackfillReport(report));
    return 0;
  } catch (err) {
    console.error((err as Error).message);
    return err instanceof TtlBackfillAbortedError ? 3 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
