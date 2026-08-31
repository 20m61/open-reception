#!/usr/bin/env tsx
/**
 * 外側ループ（規約改善）の点検と、改善スキルへ渡す**証拠束**の印字 (issue #424)。
 *
 * 判定は純関数（`src/domain/governance/loop-retro.ts`）で、ここは I/O と表示だけ。
 *
 * 使い方:
 *   npx tsx scripts/loop-retro.ts          # 指摘があれば exit 1
 *   npx tsx scripts/loop-retro.ts --report # 指摘の有無に関わらず exit 0（報告のみ）
 *
 * **`quality-gate.sh` には組み込まない。** あちらはコード品質の門で、こちらは
 * 「外側ループが回っているか」の点検。混ぜると、外側が止まっている間ずっと開発者の
 * ローカルゲートが赤くなり override が習慣化する（`evaluate-gate-runs.ts` と同じ判断）。
 * 構造の検査（教訓の上限・帰属）は偽陽性が無いので、**そちらだけ**が
 * `src/domain/governance/loop-retro.test.ts` 経由でゲートの unit に入っている。
 *
 * 既定で exit 1 にしているのは、定期実行から呼んだときに黙って流れないため。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GUIDELINE_BUDGET,
  evaluateLoopRetro,
  parseLearnedGuidelines,
  parseRetroRuns,
  parseRulesRevision,
  type LoopRetroFinding,
} from '../src/domain/governance/loop-retro';

const REPORT_ONLY = process.argv.includes('--report');
const ROOT = resolve(import.meta.dirname, '..');
const RULES = resolve(ROOT, '.claude', 'rules', 'opus5-autonomous-loop.md');
const LEDGER = resolve(ROOT, 'docs', 'loop-retro.md');

function icon(f: LoopRetroFinding): string {
  return f.severity === 'error' ? '❌' : '⚠️ ';
}

function readOrExit(path: string, label: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    // **読めなかったことを「指摘なし」に落とさない。** 空文字で続けると教訓 0 件・
    // 記録 0 件になり、`never_run` が「ファイルが無い」のか「回っていない」のか
    // 区別できなくなる（#717 と同じ型）。
    console.error(`${label} を読めませんでした: ${path}`);
    process.exit(2);
  }
}

function main(): number {
  const rules = readOrExit(RULES, '.claude/rules/opus5-autonomous-loop.md');
  const ledger = readOrExit(LEDGER, 'docs/loop-retro.md');

  const guidelines = parseLearnedGuidelines(rules);
  const runs = parseRetroRuns(ledger);
  const rulesRevision = parseRulesRevision(rules);

  console.log('▶ 外側ループ（規約改善）の点検 (#424)');
  console.log(`  規約版: ${rulesRevision ?? '不明（版マーカーが無い）'}`);
  console.log(`  教訓: ${guidelines.length} / ${GUIDELINE_BUDGET} 件`);
  console.log(`  実行記録: ${runs.length} 件`);
  if (runs.length > 0) {
    const latest = runs[0];
    console.log(`  直近: ${latest?.at} / 版 ${latest?.revisionFrom}→${latest?.revisionTo} / ${latest?.result}`);
    const changed = runs.filter((r) => r.result === 'UPDATED').length;
    console.log(`  内訳: UPDATED ${changed} / NO_CHANGE ${runs.length - changed}`);
  }

  // 改善スキルが最初に読む証拠束。**どの教訓がいつ・どの周回から来たか**を並べる。
  // これが無いと、スキルは毎回ファイルを読み直して帰属を手で導くことになる。
  console.log('');
  console.log('▶ 教訓の棚卸し（古い順に、帰属つき）');
  const sorted = [...guidelines].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  for (const g of sorted) {
    const refs = [
      ...g.issues.map((n) => `#${n}`),
      ...g.pulls.map((n) => `PR #${n}`),
    ].join(' ');
    console.log(`  ${g.date ?? '日付なし'}  ${refs || '帰属なし'}  — ${g.heading || '見出しなし'} (行 ${g.line})`);
  }

  const findings = evaluateLoopRetro({ guidelines, runs, rulesRevision, now: new Date() });
  if (findings.length === 0) {
    console.log('');
    console.log('✅ 指摘はありません（外側ループが回っており、教訓は上限内で帰属を持つ）');
    return 0;
  }

  console.log('');
  for (const f of findings) console.log(`${icon(f)} [${f.code}] ${f.message}`);
  console.log('');
  console.log(`指摘 ${findings.length} 件（error ${findings.filter((f) => f.severity === 'error').length}）`);
  console.log('改善を回すには `/loop-retro` を実行してください。');

  return REPORT_ONLY ? 0 : 1;
}

process.exit(main());
