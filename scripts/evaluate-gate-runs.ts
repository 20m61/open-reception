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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  evaluateGateRuns,
  parseGateRuns,
  type GateRunFinding,
} from '../src/domain/governance/gate-run-evaluation';

const REPORT_ONLY = process.argv.includes('--report');
const GATE_RUNS = resolve(import.meta.dirname, '..', 'docs', 'gate-runs.md');

function icon(f: GateRunFinding): string {
  return f.severity === 'error' ? '❌' : '⚠️ ';
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
  const findings = evaluateGateRuns(runs, new Date());

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
    console.log('✅ 指摘はありません（定期実行が回っており、直近も green）');
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
