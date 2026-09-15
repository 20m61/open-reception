#!/usr/bin/env tsx
/**
 * PR を **REST だけ**で squash マージする (issue #702)。
 *
 * ## なぜ GitHub CLI (`gh`) を呼ばないのか
 *
 * 当初の理由は GraphQL だった。クラウドのサンドボックスの `gh` は PR レビュー用の
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
 *
 * 🔴 **2026-09-15、その前提ごと外れた (#1117)。** Claude Code on the web の
 * サンドボックスには **`gh` が無い**ので、`gh api` へ寄せた回避策も成立しない。
 * したがって **CLI ごとやめ、REST を HTTP でそのまま叩く**（`scripts/lib/github-api.ts`）。
 * 作成側と**同じ 1 経路**に揃える ―― 経路が 2 つあると、片方だけが動く環境で
 * 「動いたはず」の誤読が起きる。
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
import { callGitHubJson, resolveRepoFromOrigin } from './lib/github-api';
import type { GitHubRepo } from '../src/domain/governance/git-base';
import {
  pullMergeRequest,
  pullReadRequest,
  type GitHubRequest,
} from '../src/domain/governance/github-rest';

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

  let repo: GitHubRepo;
  let mergeRequest: GitHubRequest;
  try {
    repo = resolveRepoFromOrigin();
    mergeRequest = pullMergeRequest(repo, pullNumber);
  } catch (e) {
    console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  let mergeError: string | undefined;
  try {
    console.error(JSON.stringify(callGitHubJson<unknown>(mergeRequest)));
  } catch (e) {
    // ここで終わらせない。**既にマージ済みなら目的は達成されている**（再実行は 405 になる）。
    mergeError = e instanceof Error ? e.message : String(e);
  }

  // 🔴 **マージできたと言われても信じない。** 状態を REST で引き直す。
  // `merged !== true` を落とす向きに倒す（読めなかったことを「マージ済み」と読まない）。
  let merged: boolean;
  try {
    merged = callGitHubJson<{ merged?: boolean }>(pullReadRequest(repo, pullNumber)).merged === true;
  } catch (e) {
    console.error(`❌ マージ結果を確認できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    if (mergeError !== undefined) console.error(`   マージ時のエラー: ${mergeError}`);
    return 4;
  }

  if (!merged) {
    console.error(`❌ PR #${pullNumber} はマージされていません。`);
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
