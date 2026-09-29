/**
 * deploy wrapper を子プロセスで起動するテストの**親環境**を作る (#1195)。
 *
 * ## なぜ要るか
 *
 * wrapper（`aws-cloud-deploy.sh` / `aws-issue-credentials.sh` 等）は #1148 以降、
 * 廃止変数（`RETIRED_DEPLOY_CONTEXT_VARS`）が**環境に在るだけで**全サブコマンドの先頭で止まる。
 * テストが `{ ...process.env }` をそのまま渡すと、**テストを走らせている環境**に廃止変数が
 * 残っているとき、credential 解決・`aws` の有無・VITEST インターロックなど**別の経路を
 * 測るはずのテストが、全部その先頭の検査で止まって落ちる**。
 *
 * 2026-09-28、Cloud 環境に `OR_ORIGIN_VERIFY_SECRET` が残っていたため、main の `--full` で
 * `aws-cloud-deploy.test.ts` 6 件・`aws-issue-credentials.test.ts` 5 件がこれで落ちた。
 * 実装は正しく止まっており（それが #1148 の狙い）、壊れていたのは**テストの前提**である。
 *
 * ## 何を落とし、何を落とさないか
 *
 * 落とすのは廃止変数だけ。一覧は正本（`deploy-context.ts`）から取り、ここで書き写さない。
 * **廃止変数の検査そのもの**を測るテストは、この環境へ明示的に値を足して起動する
 * （`aws-cloud-deploy.test.ts` の #1148 節）ので、検査が効いていることは引き続き縛られる。
 *
 * 🔴 環境に廃止変数が在ること自体は**直すべき状態**である（値は露出したものとして扱い、
 * 環境ダイアログから削除して入れ替える。`docs/runbook-cloud-aws-deploy.md`）。
 * このヘルパはそれを隠すためのものではなく、**別の経路のテストを巻き添えにしない**ためのもの。
 */
import { RETIRED_DEPLOY_CONTEXT_VARS } from '../../src/domain/governance/deploy-context';

/** `process.env` の複製から廃止変数を除いたもの。元の `process.env` は変更しない。 */
export function envWithoutRetiredDeployVars(
  base: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  // 子プロセスへ渡す形（`NodeJS.ProcessEnv`）で返す。中身は base の複製なので型だけを合わせる。
  const env = { ...base } as NodeJS.ProcessEnv;
  for (const name of RETIRED_DEPLOY_CONTEXT_VARS) delete env[name];
  return env;
}
