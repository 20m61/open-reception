/**
 * デプロイに必須の CDK context を解決して `cdk` へ渡す引数を印字する CLI（#680）。
 *
 * `scripts/aws-cloud-deploy.sh` の `diff` / `deploy` が呼ぶ。判定は
 * `src/domain/governance/deploy-context.ts`（純関数）に持ち、ここは I/O だけ。
 *
 * 成功時: `-c` と `key=value` を **1 行に 1 つ**印字する（値に空白が入っても壊れないよう、
 * シェル側は `while IFS= read -r` で配列へ積む）。
 * 失敗時: 診断を stderr に出して**非ゼロで終わる**。呼び出し側はそこで止まる。
 */
import { resolveDeployContext } from '../src/domain/governance/deploy-context';

function main(): void {
  const result = resolveDeployContext(process.env);
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  for (const arg of result.args) {
    console.log(arg);
  }
}

main();
