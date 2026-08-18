#!/usr/bin/env tsx
/**
 * PR を **REST だけ**で squash マージする (issue #702)。
 *
 * ## なぜ `gh pr merge` を呼ばないのか
 *
 * クラウドのサンドボックス（Claude Code on the web / Routine）の `gh` は、PR レビュー用の
 * pinned な操作セットしか GraphQL を通さない。2026-08-18 の PR #701 のマージで実測:
 *
 * ```
 * gh pr merge 701 --squash --delete-branch
 * non-200 OK status code: 403 Forbidden
 * body: "This GraphQL query is not enabled for this session ... Use REST via
 *        `gh api repos/{owner}/{repo}/...` instead."
 * ```
 *
 * PR 作成を REST へ移した #678 と**同じ理由が同じようにマージ側にも当てはまった**。
 * 開発がクラウド既定になった以上、マージも全周回の通り道なのでここへ寄せる。
 *
 * ## 使い方
 *
 * ```bash
 * npx tsx scripts/merge-pull-request.ts --number 703
 * ```
 *
 * ## 保証していること
 *
 * 1. **squash を明示する**（GitHub の既定は merge commit）。
 * 2. **マージできたという申告を信じない。** マージ後に `GET .../pulls/<n>` を引き直し、
 *    `merged === true` を確認できたときだけ 0 で終わる（#656 の作法をマージ側にも適用）。
 * 3. **失敗の理由（stderr）を落とさない。**
 *
 * ## ゲートとの関係
 *
 * `scripts/hooks/pr-gate-guard.sh` はこの経路を **`--full` 要求の対象**にしている。
 * マージの主経路を移したことがそのままゲートの抜け道にならないようにするため
 * （#678 で作成側について同じ手当てをした）。
 */
import { execFileSync } from 'node:child_process';
import { describeCommandFailure } from '../src/domain/governance/command-failure';
import { parseGitHubRepo, pullMergeArgs } from '../src/domain/governance/git-base';

function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    throw new Error(describeCommandFailure(`${cmd} ${args.join(' ')}`, e));
  }
}

function readOption(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} に値がありません`);
  return value;
}

function main(): number {
  let raw: string | undefined;
  try {
    raw = readOption('number');
  } catch (e) {
    console.error(`❌ 引数を読めませんでした: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (raw === undefined) {
    console.error('使い方: merge-pull-request.ts --number <PR 番号>');
    return 2;
  }
  const pullNumber = Number(raw);

  let remoteUrl: string;
  try {
    remoteUrl = run('git', ['ls-remote', '--get-url', 'origin']);
  } catch (e) {
    console.error(`❌ origin の URL を取得できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const repo = parseGitHubRepo(remoteUrl);
  if (repo === undefined) {
    console.error(`❌ origin の URL から owner/repo を読み取れませんでした: ${remoteUrl}`);
    return 2;
  }

  let mergeArgs: string[];
  try {
    mergeArgs = pullMergeArgs(repo, pullNumber);
  } catch (e) {
    console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  let mergeError: string | undefined;
  try {
    console.error(run('gh', mergeArgs));
  } catch (e) {
    // ここで終わらせない。**既にマージ済みなら目的は達成されている**（再実行は 405 になる）。
    mergeError = e instanceof Error ? e.message : String(e);
  }

  // 🔴 **マージできたと言われても信じない。** 状態を REST で引き直す。
  const owner = encodeURIComponent(repo.owner);
  const name = encodeURIComponent(repo.repo);
  let merged: string;
  try {
    merged = run('gh', ['api', `repos/${owner}/${name}/pulls/${pullNumber}`, '--jq', '.merged']);
  } catch (e) {
    console.error(`❌ マージ結果を確認できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    if (mergeError !== undefined) console.error(`   マージ時のエラー: ${mergeError}`);
    return 4;
  }

  if (merged !== 'true') {
    console.error(`❌ PR #${pullNumber} はマージされていません（merged=${merged}）。`);
    if (mergeError !== undefined) console.error(`   理由: ${mergeError}`);
    return 4;
  }

  if (mergeError !== undefined) {
    console.error(`ℹ️  マージ要求は失敗しましたが、PR は既にマージ済みでした（理由: ${mergeError}）`);
  }
  console.error(`✅ PR #${pullNumber} が squash マージされたことを REST で確認しました`);
  console.log(`merged #${pullNumber}`);
  return 0;
}

process.exit(main());
