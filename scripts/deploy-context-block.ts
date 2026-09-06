/**
 * 窓を開けるときに貼る「デプロイ context 4 変数」のブロックを stdout へ出す (#989)。
 *
 * `scripts/aws-issue-credentials.sh --with-context`（既定 ON）から呼ばれる薄い I/O 層。
 * 判定そのものは `src/domain/governance/deploy-context.ts` の純関数が持つ ――
 * `aws-cloud-deploy.sh` の必須 context ガードと**同じ基準**を使うため。
 * ここで基準を写経すると、片方だけ直る型の欠陥になる。
 *
 * 🔴 **値をコマンドライン引数に載せない。** 受け渡しは env と stdout だけ
 * （argv に載ると `ps` の引数一覧へ秘密が出る。`aws-issue-credentials.sh` の
 * node 呼び出しと同じ方針）。
 *
 * 解決順は **env が先、ファイルが後**。シェルで一時的に上書きして試せるようにしておく
 * （ファイルを書き換えて戻し忘れる方が事故になりやすい）。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  parseDeployContextFile,
  resolveDeployContextEnvBlock,
} from '../src/domain/governance/deploy-context';

/**
 * 既定はリポジトリの**外**。`OR_ORIGIN_VERIFY_SECRET` は秘密の値そのものなので、
 * 作業ツリーに置いて `.gitignore` に頼る形にしない（ignore 行が消えた瞬間に commit され得る）。
 */
function contextFilePath(env: NodeJS.ProcessEnv): string {
  const override = env.OR_DEPLOY_CONTEXT_FILE?.trim();
  if (override !== undefined && override !== '') return override;
  return join(homedir(), '.config', 'open-reception', 'deploy-context.env');
}

function readContextFile(path: string): Record<string, string> {
  try {
    return parseDeployContextFile(readFileSync(path, 'utf8'));
  } catch {
    // 🔴 読めなかった理由（不在・権限）を握り潰してよいのは、**次段で必ず落ちる**から。
    // 欠落は `resolveDeployContextEnvBlock` が変数名付きで報告する ―― ここで
    // 「ファイルが無い」とだけ言うと、env で渡している運用が誤って止まる。
    return {};
  }
}

const path = contextFilePath(process.env);
const fromFile = readContextFile(path);
// env を優先する（一時的な上書きを効かせる）。
const merged: Record<string, string | undefined> = { ...fromFile, ...process.env };

const result = resolveDeployContextEnvBlock(merged);
if (!result.ok) {
  process.stderr.write(`${result.message}\n\n`);
  process.stderr.write(`環境変数か、次のファイルで与えてください: ${path}\n`);
  process.stderr.write('（値は表示しません。ファイルはリポジトリの外に置いてください）\n');
  process.exit(2);
}

process.stdout.write(`${result.block}\n`);
