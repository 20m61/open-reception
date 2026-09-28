#!/usr/bin/env tsx
/**
 * `--full` の証拠を PR のコメントへ載せる (#1195)。
 *
 * ```bash
 * ./scripts/quality-gate.sh --full          # コミット済み・clean なツリーで
 * npm run gate:evidence -- --number <PR 番号> [--dry-run]
 * ```
 *
 * `quality-gate.sh` が `.git` 配下へ書いた証拠ファイルを読み、PR の現在の head と突き合わせ、
 * marker 付きのコメントを **1 件だけ**置く（2 回目以降は同じコメントを更新する）。
 * 判定と文面は `src/domain/governance/gate-evidence.ts`（純関数）。
 *
 * 終了コード: 0 = PASS として投稿 / 1 = PASS ではないものとして投稿 /
 *             2 = 引数・証拠ファイルの誤り（投稿しない）/ 4 = GitHub に届かない
 *
 * 🔴 **証拠ファイルを読めないときは投稿しない。** 「読めなかった」を
 * 「報告することが無い」にも「PASS」にも倒さない。
 *
 * 🔴 **マージはしない。** これは owner が merge を判断するための記録で、このスクリプトは
 * PR へコメントを書く以外の書き込みを持たない（`pr-gate-guard.sh` の対象外であり、
 * 迂回もしない）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { callGitHubArray, callGitHubJson, resolveRepoFromOrigin } from './lib/github-api';
import {
  GATE_EVIDENCE_MARKER,
  assessGateEvidence,
  parseGateEvidence,
  renderGateEvidenceComment,
} from '../src/domain/governance/gate-evidence';
import {
  issueCommentCreateRequest,
  issueCommentUpdateRequest,
  issueCommentsListRequest,
  pullReadRequest,
} from '../src/domain/governance/github-rest';

const KNOWN_OPTIONS = ['number', 'evidence', 'dry-run'] as const;
/** これ以上のページは読まない（marker を見つけられなければ新規に置く）。 */
const MAX_COMMENT_PAGES = 10;

function readOption(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} に値がありません`);
  return value;
}

function rejectUnknownOptions(): void {
  const unknown = process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => a.replace(/^--/, '').split('=')[0]!)
    .filter((n) => !KNOWN_OPTIONS.includes(n as (typeof KNOWN_OPTIONS)[number]));
  if (unknown.length > 0) {
    throw new Error(`知らない引数です: ${unknown.map((u) => `--${u}`).join(', ')}`);
  }
}

/** 既定の証拠ファイル。`quality-gate.sh` の `gate_evidence_file full` と同じ場所。 */
function defaultEvidencePath(): string {
  const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
  return join(gitDir, 'open-reception-gate-evidence-full');
}

function main(): number {
  let pullNumber: number;
  let evidencePath: string;
  const dryRun = process.argv.includes('--dry-run');
  try {
    rejectUnknownOptions();
    const raw = readOption('number');
    pullNumber = Number(raw);
    if (raw === undefined || !Number.isInteger(pullNumber) || pullNumber <= 0) {
      throw new Error('--number <PR 番号> が要ります');
    }
    const explicit = readOption('evidence');
    // 🔴 **任意のファイルを投稿させない。** 投稿するのはゲート自身が `.git` 配下へ書いた
    // 記録だけにする。`--evidence` は手元で本文を確かめる `--dry-run` 専用。
    if (explicit !== undefined && !dryRun) {
      throw new Error('--evidence は --dry-run と一緒にしか使えません（投稿はゲートが書いた記録に限る）');
    }
    evidencePath = explicit ?? defaultEvidencePath();
  } catch (e) {
    console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
    console.error('使い方: publish-gate-evidence.ts --number <PR 番号> [--evidence <path>] [--dry-run]');
    return 2;
  }

  if (!existsSync(evidencePath)) {
    console.error(`❌ 証拠ファイルがありません: ${evidencePath}`);
    console.error('   先に ./scripts/quality-gate.sh --full を（コミット済み・clean なツリーで）回してください。');
    return 2;
  }
  let evidence;
  try {
    evidence = parseGateEvidence(readFileSync(evidencePath, 'utf8'));
  } catch (e) {
    console.error(`❌ 証拠ファイルを読めません（投稿しません）: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  let repo;
  try {
    repo = resolveRepoFromOrigin();
  } catch (e) {
    console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  let headSha: string | null = null;
  try {
    const pr = callGitHubJson<{ head?: { sha?: unknown } }>(pullReadRequest(repo, pullNumber));
    headSha = typeof pr.head?.sha === 'string' ? pr.head.sha : null;
  } catch (e) {
    if (!dryRun) {
      console.error(`❌ PR #${pullNumber} を読めません: ${e instanceof Error ? e.message : String(e)}`);
      return 4;
    }
    // dry-run は PR を読めなくても本文を見せる（head 不明 = PASS にはならない）。
  }

  const assessment = assessGateEvidence(evidence, headSha);
  const body = renderGateEvidenceComment(evidence, assessment, headSha);

  if (dryRun) {
    process.stdout.write(`${body}\n`);
  } else {
    try {
      let existingId: number | undefined;
      for (let page = 1; page <= MAX_COMMENT_PAGES && existingId === undefined; page++) {
        const comments = callGitHubArray(issueCommentsListRequest(repo, pullNumber, page));
        const hit = comments.find(
          (c): c is { id: number; body: string } =>
            typeof (c as { id?: unknown }).id === 'number' &&
            typeof (c as { body?: unknown }).body === 'string' &&
            (c as { body: string }).body.includes(GATE_EVIDENCE_MARKER),
        );
        if (hit) existingId = hit.id;
        if (comments.length < 100) break;
      }
      const posted = callGitHubJson<{ html_url?: string; body?: string }>(
        existingId === undefined
          ? issueCommentCreateRequest(repo, pullNumber, body)
          : issueCommentUpdateRequest(repo, existingId, body),
      );
      // 🔴 **書けたという申告を信じない。** 返ってきた本文に marker が無ければ失敗として扱う。
      if (typeof posted.body !== 'string' || !posted.body.includes(GATE_EVIDENCE_MARKER)) {
        throw new Error('投稿した本文を応答から確認できませんでした');
      }
      console.error(`${existingId === undefined ? '📝 投稿' : '♻️  更新'}: ${posted.html_url ?? '(URL 不明)'}`);
    } catch (e) {
      console.error(`❌ コメントを書けませんでした: ${e instanceof Error ? e.message : String(e)}`);
      return 4;
    }
  }

  if (assessment.passed) {
    console.error(dryRun ? '✅ --full PASS と判定（dry-run: 投稿していない）' : '✅ --full PASS として記録しました');
    return 0;
  }
  console.error(`⚠️  PASS ではありません（理由 ${assessment.reasons.length} 件）:`);
  for (const r of assessment.reasons) console.error(`   - ${r}`);
  return 1;
}

process.exit(main());
