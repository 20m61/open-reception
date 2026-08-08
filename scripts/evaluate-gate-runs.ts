#!/usr/bin/env tsx
/**
 * 定期ゲート実行記録の評価レポート (issue #424)。
 *
 * `docs/gate-runs.md` を読み、**事前定義した停止条件**に照らして指摘を出す。
 * 判定は純関数（`src/domain/governance/gate-run-evaluation.ts`）で、ここは I/O と表示だけ。
 *
 * 使い方:
 *   npx tsx scripts/evaluate-gate-runs.ts          # 指摘があれば exit 1
 *   npx tsx scripts/evaluate-gate-runs.ts --report # 指摘の有無に関わらず exit 0（報告のみ）
 *
 * **既定で exit 1 にしているのは、週次 Routine から呼んだときに黙って流れないため。**
 * ゲート本体（`quality-gate.sh`）には**組み込まない** — あちらはコード品質の門で、
 * こちらは「運用が回っているか」の点検。混ぜると、Routine が止まっている間ずっと
 * 開発者のローカルゲートが赤くなり、override が習慣化する（#424 増分 4 と同じ判断）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  evaluateGateRuns,
  evaluateRecordBranches,
  parseGateRuns,
  type BranchPullRequest,
  type GateRunFinding,
} from '../src/domain/governance/gate-run-evaluation';
import { resolveDefaultBranchName, type GitRunner } from '../src/domain/governance/git-base';

const REPORT_ONLY = process.argv.includes('--report');
const GATE_RUNS = resolve(import.meta.dirname, '..', 'docs', 'gate-runs.md');

function icon(f: GateRunFinding): string {
  return f.severity === 'error' ? '❌' : '⚠️ ';
}

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * リモートのブランチと PR の対応を集め、PR にならなかった push を検出する (#656)。
 *
 * **PR は「そのブランチを head に持つもの」を 1 本ずつ問い合わせる。** `gh pr list` を
 * 一括で引くと `--limit` を超えた古い PR が落ち、**その PR を持つブランチが orphan に
 * 誤検出される**。ブランチは通常数本なので、正確な方を選ぶ。
 *
 * **収集に失敗したら「穴なし」ではなく「未検査」を返す。** 空の結果を「問題なし」と
 * 読むのは、この検査が塞ごうとしている穴そのものと同じ失敗（`|| true` の空文字を
 * fresh と読む類）。
 */
function evaluateBranches(): GateRunFinding[] {
  let defaultBranch: string;
  let branchNames: string[];
  try {
    /**
     * **既定ブランチ名は git を先に見る** (#656)。
     *
     * 当初は `gh repo view` だけだったが、**クラウドの週次ゲート環境で落ちて検査が
     * 到達しなかった**（PR #661 の実走。同じセッションで `gh pr create` /
     * `gh pr merge` は成功していたので、落ちたのは gh のリポジトリ解決だけ）。
     * remote 追跡 HEAD ならクローン済みリポジトリで完結し、追加の権限も要らない。
     * gh は fallback に回す。
     */
    const gitRunner: GitRunner = (args) => {
      try {
        return run('git', [...args]);
      } catch {
        return null;
      }
    };
    defaultBranch =
      resolveDefaultBranchName(gitRunner) ??
      run('gh', ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']);
    branchNames = run('git', ['ls-remote', '--heads', 'origin'])
      .split('\n')
      .map((line) => line.split('refs/heads/')[1] ?? '')
      .filter((name) => name !== '');
  } catch (e) {
    return [
      {
        code: 'branch_check_unverified',
        severity: 'warning',
        message: `リモートブランチの検査を実行できませんでした（${e instanceof Error ? e.message.split('\n')[0] : String(e)}）。git の remote 追跡と、PR 問い合わせ用の gh・ネットワークが要ります。**「取りこぼし無し」ではなく「未検査」です。**`,
      },
    ];
  }
  if (defaultBranch === '' || branchNames.length === 0) {
    return [
      {
        code: 'branch_check_unverified',
        severity: 'warning',
        message:
          'リモートブランチの一覧または既定ブランチ名が空でした。**「取りこぼし無し」ではなく「未検査」です。**',
      },
    ];
  }

  const pullRequests: BranchPullRequest[] = [];
  for (const name of branchNames) {
    if (name === defaultBranch) continue;
    let json: string;
    try {
      json = run('gh', ['pr', 'list', '--head', name, '--state', 'all', '--limit', '1', '--json', 'state']);
    } catch (e) {
      return [
        {
          code: 'branch_check_unverified',
          severity: 'warning',
          message: `ブランチ '${name}' の PR を問い合わせられませんでした（${e instanceof Error ? e.message.split('\n')[0] : String(e)}）。**「取りこぼし無し」ではなく「未検査」です。**`,
        },
      ];
    }
    const parsed = JSON.parse(json) as { state: BranchPullRequest['state'] }[];
    const state = parsed[0]?.state;
    if (state) pullRequests.push({ headRefName: name, state });
  }

  return evaluateRecordBranches(
    branchNames.map((name) => ({ name })),
    pullRequests,
    defaultBranch,
  );
}

function main(): number {
  let markdown: string;
  try {
    markdown = readFileSync(GATE_RUNS, 'utf8');
  } catch {
    console.error(`docs/gate-runs.md を読めませんでした: ${GATE_RUNS}`);
    return 2;
  }

  const runs = parseGateRuns(markdown);
  const findings = [...evaluateGateRuns(runs, new Date()), ...evaluateBranches()];

  console.log('▶ 定期ゲート実行記録の評価 (#424)');
  console.log(`  記録件数: ${runs.length}`);
  if (runs.length > 0) {
    const latest = runs[0];
    console.log(`  直近: ${latest?.at} / ${latest?.sha} / ${latest?.result}`);
    const recent = runs.slice(0, 5);
    const pass = recent.filter((r) => r.result === 'PASS').length;
    console.log(`  直近 ${recent.length} 回: PASS ${pass} / FAIL ${recent.length - pass}`);
  }

  if (findings.length === 0) {
    console.log(
      '✅ 指摘はありません（定期実行が回っており、直近も green。記録に穴が無く、PR にならず残ったブランチも無い）',
    );
    return 0;
  }

  console.log('');
  for (const f of findings) {
    console.log(`${icon(f)} [${f.code}] ${f.message}`);
  }
  console.log('');
  console.log(`指摘 ${findings.length} 件（error ${findings.filter((f) => f.severity === 'error').length}）`);

  return REPORT_ONLY ? 0 : 1;
}

process.exit(main());
