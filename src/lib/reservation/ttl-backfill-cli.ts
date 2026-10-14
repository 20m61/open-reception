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
 * 終了コード: 0 = 完了 / 1 = 実行時エラー / 2 = 引数の誤り / 3 = dry-run 後に件数が変わった（未書き込み）
 * （対応は `ttlBackfillExitCode`）。
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

/**
 * 終了コード: 0 = 完了 / 1 = 実行時エラー / 2 = 引数の誤り / 3 = dry-run 後に件数が変わった（未書き込み）。
 * `failure` は投げられたもの（成功なら `undefined`）。runbook の表と同じ対応を unit が縛る。
 */
export function ttlBackfillExitCode(failure: unknown): 0 | 1 | 2 | 3 {
  if (failure === undefined) return 0;
  if (failure instanceof TtlBackfillUsageError) return 2;
  if (failure instanceof TtlBackfillAbortedError) return 3;
  return 1;
}

export type TtlBackfillCliDeps = {
  /** 向き先を解決して client を作る。`target` は最初に stderr へ出す（owner が目で確かめる）。 */
  readonly connect: () => { readonly doc: Pick<DynamoDBDocumentClient, 'send'>; readonly target: string };
  readonly nowMs: () => number;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
};

/** CLI 本体。投げたものは全部 `ttlBackfillExitCode` で終了コードへ写す（未処理の reject にしない）。 */
export async function runTtlBackfillCli(
  argv: readonly string[],
  deps: TtlBackfillCliDeps,
): Promise<number> {
  try {
    const args = parseTtlBackfillArgs(argv);
    const { doc, target } = deps.connect();
    deps.err(`target: ${target} table=${args.table}`);
    const report = await runReservationTtlBackfill({
      doc,
      table: args.table,
      nowMs: deps.nowMs(),
      apply: args.apply,
    });
    deps.out(args.json ? JSON.stringify(report, null, 2) : formatTtlBackfillReport(report));
    return ttlBackfillExitCode(undefined);
  } catch (err) {
    deps.err(err instanceof Error ? err.message : String(err));
    return ttlBackfillExitCode(err);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTtlBackfillCli(process.argv.slice(2), {
    connect: () => {
      const config = awsClientConfig();
      return {
        doc: DynamoDBDocumentClient.from(new DynamoDBClient(config)),
        target: `runtime=${resolveAwsRuntime(process.env)} region=${config.region}`,
      };
    },
    nowMs: () => Date.now(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  }).then((code) => {
    process.exitCode = code;
  });
}
