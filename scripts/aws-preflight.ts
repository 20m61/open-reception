/**
 * preflight 判定 CLI (spec §5)。
 *
 * `scripts/aws-cloud-deploy.sh` が集めた観測を JSON で受け取り、
 * `src/domain/governance/deploy-preflight.ts` に判定させて印字する。
 * **不一致があれば非ゼロで終わる。**
 */
import { readFileSync } from 'node:fs';
import {
  DEFAULT_PREFLIGHT_REQUIREMENT,
  evaluatePreflight,
  type PreflightObservation,
} from '../src/domain/governance/deploy-preflight';

const STRING_FIELDS = ['callerArn', 'accountId', 'region', 'qualifier', 'environment'] as const;
const BOOLEAN_FIELDS = [
  'workingTreeClean',
  'headCommitPushed',
  'gateStampSatisfied',
  'negativeTestsPassed',
] as const;

/**
 * 🔴 **これはセキュリティ CLI で、入力は「公開された argv 契約」である。** `JSON.parse(...)
 * as PreflightObservation` は実行時の形を何も保証しない。呼び出し元は今のところ
 * `scripts/aws-cloud-deploy.sh` の 1 箇所だけだが、それだけを信頼して検証を省くと、
 * 将来別の呼び出し元や壊れた観測ファイルが渡されたときに「判定不能」が静かに
 * 「PASS」へ丸め込まれる（`deploy-preflight.ts` 側にも `== null` の防御はあるが、
 * ここは境界そのものなので二重に守る）。フィールドが 1 つでも契約を満たさなければ
 * 具体的な理由を添えて非ゼロで終わる。
 */
function validateObservationShape(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['observation は JSON オブジェクトである必要があります'];
  }
  const v = value as Record<string, unknown>;

  for (const field of STRING_FIELDS) {
    if (typeof v[field] !== 'string' || v[field] === '') {
      problems.push(`${field} は非空文字列である必要があります（実際: ${JSON.stringify(v[field])}）`);
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof v[field] !== 'boolean') {
      problems.push(`${field} は boolean である必要があります（実際: ${JSON.stringify(v[field])}）`);
    }
  }
  // credentialSecondsRemaining は number か null のどちらかでなければならない。
  // 欠落（undefined）は明示的に拒否する — 「無いので判定不能」を deploy-preflight.ts の
  // `== null` 側の防御だけに委ねない。
  const csr = v.credentialSecondsRemaining;
  if (csr !== null && typeof csr !== 'number') {
    problems.push(
      `credentialSecondsRemaining は number か null である必要があります（実際: ${JSON.stringify(csr)}。欠落は不可）`,
    );
  }
  return problems;
}

function main(): void {
  const [jsonPath, minSecondsArg] = process.argv.slice(2);
  if (jsonPath === undefined) {
    console.error('Usage: tsx scripts/aws-preflight.ts <observation-json> [minCredentialSeconds]');
    process.exit(2);
  }

  const parsed: unknown = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const shapeProblems = validateObservationShape(parsed);
  if (shapeProblems.length > 0) {
    console.error('  ⛔ observation の形式が不正です:');
    for (const p of shapeProblems) console.error(`    - ${p}`);
    process.exit(2);
  }
  const observed = parsed as PreflightObservation;

  // 🔴 **`Number(minSecondsArg)` は非数値を素通りさせて NaN を作る。** `NaN < 何か` は
  // 常に false なので、ゴミを argv[3] に渡すだけで credential 残時間チェックが無効化される
  // （Important 4）。`Number.isFinite` で明示的に拒否する。
  let minCredentialSeconds = DEFAULT_PREFLIGHT_REQUIREMENT.minCredentialSeconds;
  if (minSecondsArg !== undefined) {
    const parsedMinSeconds = Number(minSecondsArg);
    if (!Number.isFinite(parsedMinSeconds)) {
      console.error(`  ⛔ minCredentialSeconds が数値ではありません: ${JSON.stringify(minSecondsArg)}`);
      process.exit(2);
    }
    minCredentialSeconds = parsedMinSeconds;
  }

  const required = { ...DEFAULT_PREFLIGHT_REQUIREMENT, minCredentialSeconds };
  const verdict = evaluatePreflight(observed, required);
  if (verdict.ok) {
    console.log('  ✅ preflight 全項目 PASS');
    return;
  }
  console.error('  ⛔ preflight 不一致:');
  for (const f of verdict.failures) console.error(`    - ${f.field}: ${f.detail}`);
  process.exit(1);
}

main();
