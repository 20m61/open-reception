/**
 * ループの kill switch と 1 周回の変更量の報告 CLI (issue #424 増分 4)。
 *
 * 判定は `src/domain/governance/change-budget.ts`（純関数・ユニットテスト済）にあり、
 * ここは I/O だけ——env / 停止ファイル / git を読んで渡し、結果を印字する。
 *
 * **終了コードは kill switch だけで決まる**（halted なら 1 = ゲート FAIL）。変更量は超えても 0
 * を返す（報告のみ）。理由は `change-budget.ts` の冒頭に書いたとおりで、変更量で赤くすると
 * override が習慣化し、change-risk (#424 増分 3) で避けた失敗を繰り返す。
 *
 * `scripts/quality-gate.sh` が**最初に**呼ぶ。kill switch は 10 分のゲートを走らせる前に
 * 効かなければ意味がない。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_CHANGE_BUDGET,
  evaluateChangeBudget,
  resolveKillSwitch,
  type ChangeStat,
} from '../src/domain/governance/change-budget';
import { resolveBase } from '../src/domain/governance/git-base';

/** 停止ファイル。追跡しない（コミットすると全員のゲートを止めてしまう）。 */
const HALT_FILE = '.loop-halt';
const HALT_ENV = 'OPEN_RECEPTION_LOOP_HALT';

const ROOT = join(import.meta.dirname, '..');

function tryGit(args: ReadonlyArray<string>): string | null {
  try {
    return execFileSync('git', [...args], { encoding: 'utf8', cwd: ROOT });
  } catch {
    return null;
  }
}

/**
 * 比較起点。**`change-risk.ts` と同じ実装を共有する** (#557)。
 *
 * かつては両者が同じ解決を別々に書いていて、同一実行の中で「47 ファイル / 2365 行」と
 * 「7 件」が併記された。起点が新しいかどうか（浅い clone 対策）は `quality-gate.sh` が
 * 先に保証する — 測る側でこっそり fetch しない。
 */
const resolveBaseRef = (): string | null => resolveBase(tryGit, process.env.GATE_BASE_SHA);

/**
 * 変更量を集める。**ゲートが検査するのは作業ツリー**なので、`git diff <base>`（HEAD を挟まず
 * 作業ツリーと比較）でコミット済み + 未コミットをまとめて見る。未追跡ファイルは numstat に
 * 出ないため別途数える（新規ディレクトリごと足したときに丸ごと消えるのを防ぐ・増分 3 と同じ罠）。
 */
function collectStat(base: string | null): ChangeStat & { failures: string[] } {
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  /**
   * 集めきれなかった git コマンド (#712)。
   *
   * 失敗を黙って空文字へ落とすと `0 ファイル / 0 行` と印字され、**「変更していない」と
   * 読める**。ここは報告のみで kill switch には影響しないが（判定は `resolveKillSwitch`
   * だけが持つ）、欠陥の型は #709 / #712 と同じなので、測れなかったことは表に出す。
   */
  const failures: string[] = [];

  const numstat = base === null ? null : tryGit(['diff', '--numstat', base]);
  if (base !== null && numstat === null) failures.push(`git diff --numstat ${base}`);
  for (const line of (numstat ?? '').split('\n')) {
    if (line.trim() === '') continue;
    const [add, del] = line.split('\t');
    files += 1;
    // バイナリは `-` になる。行数は数えられないのでファイル数だけ加算する。
    insertions += Number.parseInt(add ?? '', 10) || 0;
    deletions += Number.parseInt(del ?? '', 10) || 0;
  }

  const untracked = tryGit(['ls-files', '--others', '--exclude-standard']);
  if (untracked === null) failures.push('git ls-files --others --exclude-standard');
  for (const line of (untracked ?? '').split('\n')) {
    const path = line.trim();
    if (path === '' || path === HALT_FILE) continue;
    files += 1;
    try {
      insertions += readFileSync(join(ROOT, path), 'utf8').split('\n').length;
    } catch {
      // 読めないもの（バイナリ・消えた直後）はファイル数だけ数える。
    }
  }

  return { files, insertions, deletions, failures };
}

function readHaltFile(): string | undefined {
  try {
    return readFileSync(join(ROOT, HALT_FILE), 'utf8');
  } catch {
    return undefined;
  }
}

const kill = resolveKillSwitch({ env: process.env[HALT_ENV], fileContent: readHaltFile() });

if (kill.halted) {
  const via = kill.source === 'file' ? `${HALT_FILE} が置かれています` : `${HALT_ENV} が立っています`;
  console.log(`  🛑 ループは停止中です（${via}）`);
  if (kill.reason !== null) console.log(`     理由: ${kill.reason}`);
  console.log(`  → 解除するまでゲートは通しません（${HALT_FILE} を削除 / ${HALT_ENV} を外す）`);
  process.exit(1);
}

const base = resolveBaseRef();
const stat = collectStat(base);
const verdict = evaluateChangeBudget(stat, DEFAULT_CHANGE_BUDGET);

console.log(`  停止指示なし（${HALT_FILE} / ${HALT_ENV} のいずれも立っていません）`);
console.log(
  `  変更量: ${verdict.files} ファイル / ${verdict.changedLines} 行` +
    `（目安 ${verdict.limits.maxFiles} / ${verdict.limits.maxChangedLines}` +
    `${base === null ? '・起点不明のため作業ツリーのみ' : ''}）`,
);
// **測れなかったことを「変更していない」と読ませない** (#712)。
for (const failed of stat.failures) {
  console.log(`  ⚠ 変更量を集めきれていません（失敗: ${failed}）`);
}
if (!verdict.withinBudget) {
  const axes = verdict.exceeded.map((a) => (a === 'files' ? 'ファイル数' : '行数')).join(' / ');
  console.log(`  ⚠ 1 周回の目安を超えています（${axes}）。report のみ・ゲートは FAIL させません`);
  console.log('  → 分割できないか見直し、分割しないなら PR 本文にその理由を書く');
}
