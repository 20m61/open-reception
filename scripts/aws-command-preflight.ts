/**
 * 依存コマンドの有無を検査する CLI (#680)。
 *
 * `scripts/aws-cloud-deploy.sh` の `collect_observation` が、`aws sts get-caller-identity`
 * を呼ぶ**前**に呼ぶ。bash 側が `command -v` で確認した結果を `name=true|false` の argv
 * として受け取り、`src/domain/governance/command-preflight.ts`（純関数）に判定させる。
 *
 * 引数の形式を argv で受けるのは `scripts/aws-preflight.ts` が観測 JSON をファイル経由で
 * 受けるのと同じ発想 ―― 判定ロジックは持たず、境界での形式チェックだけをここで行う。
 */
import {
  evaluateCommandAvailability,
  formatMissingCommandMessage,
} from '../src/domain/governance/command-preflight';

function parseArgs(argv: ReadonlyArray<string>): Record<string, boolean> {
  const observed: Record<string, boolean> = {};
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    if (eq === -1) {
      console.error(`  ⛔ 引数の形式が不正です（name=true|false ではありません）: ${arg}`);
      process.exit(2);
    }
    const name = arg.slice(0, eq);
    const value = arg.slice(eq + 1);
    if (value !== 'true' && value !== 'false') {
      console.error(`  ⛔ 引数の値が true/false ではありません: ${arg}`);
      process.exit(2);
    }
    observed[name] = value === 'true';
  }
  return observed;
}

function main(): void {
  const observed = parseArgs(process.argv.slice(2));
  const verdict = evaluateCommandAvailability(observed);
  if (verdict.ok) {
    console.log('  ✅ 依存コマンド確認 OK');
    return;
  }
  console.error(`  ⛔ ${formatMissingCommandMessage(verdict.missing)}`);
  process.exit(1);
}

main();
