/**
 * `--only` を解決してデプロイ対象スタック名を印字する CLI（#680）。
 *
 * `scripts/aws-cloud-deploy.sh` の `diff` / `deploy` が呼ぶ。判定は
 * `src/domain/governance/deploy-stack-selection.ts`（純関数）に持ち、ここは I/O だけ。
 *
 * 使い方: `tsx scripts/aws-stack-selection.ts <only> <stack1> <stack2> ...`
 * 成功時はスタック名を 1 行に 1 つ印字、失敗時は診断を stderr に出して非ゼロで終わる。
 */
import { selectDeployStacks } from '../src/domain/governance/deploy-stack-selection';

function main(): void {
  const [only, ...all] = process.argv.slice(2);
  if (all.length === 0) {
    console.error('Usage: tsx scripts/aws-stack-selection.ts <only> <stack...>');
    process.exit(2);
  }
  const result = selectDeployStacks(all, only);
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  for (const stack of result.selected) console.log(stack);
}

main();
