#!/usr/bin/env tsx
/**
 * クラウド委譲プロンプトを組み立てて標準出力へ出す (#656 の型を委譲側へ適用)。
 *
 * 使い方:
 *   npm run --silent delegate:prompt -- <spec.json>
 *
 * `spec.json` は `DelegationInput`（`src/domain/governance/delegation-prompt.ts`）。
 * 判定と本文の組み立ては純関数側にあり、ここは I/O だけ。
 *
 * **routine の作成は自動化できない。** `RemoteTrigger` は認証がプロセス内にあるツールで、
 * ここからは叩けない。本文を出すところまでが責務で、送信と
 * `clear_mcp_connections` は呼び出し側が行う（後者は忘れると全コネクタが付く）。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDelegationPrompt, type DelegationInput } from '../src/domain/governance/delegation-prompt';
import {
  checkLocalFastGateDeclaration,
  verdictFromExitCode,
  type StampVerdict,
} from '../src/domain/governance/gate-stamp-check';

const specPath = process.argv[2];
if (specPath === undefined) {
  console.error('使い方: npm run --silent delegate:prompt -- <spec.json>');
  process.exit(2);
}

let input: DelegationInput;
try {
  input = JSON.parse(readFileSync(specPath, 'utf8')) as DelegationInput;
} catch (e) {
  console.error(`spec を読めませんでした（${specPath}）: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

/**
 * ゲートスタンプで `localFastGate` の申告を裏取りする (#711)。
 *
 * 判定はシェル側（`gate_stamp_satisfies`）に 1 つだけ在る。**TS 側に同じ判定を
 * 書き直さない**（同じ問いに 2 つの実装があると食い違いに気づけない / #557）。
 * ここは終了コードを受け取るだけで、意味づけは `gate-stamp-check.ts` の純関数が持つ。
 */
/** probe の生の終了コード。⚠ の原因（git 外 / 記録なし）を人へ渡すために保持する。 */
let probeExit: number | null = null;

function readStampVerdict(): StampVerdict {
  // 🔴 **root はこのスクリプトの位置から採る**（cwd ではない）。裏取りの対象は
  // 「このスクリプトが属するツリー」になる —— 別 worktree の cwd から絶対パスで
  // 呼べば、見るのは呼び出し元ではなくスクリプト側のツリーである点に注意。
  const root = join(import.meta.dirname, '..');
  const lib = join(root, 'scripts', 'lib', 'gate-stamp.sh');
  // 🔴 **「記録がまだ無い」を「満たさない」から切り出す。**
  // `gate_stamp_satisfies` は「記録ファイルが無い」も「記録はあるが現ツリーと
  // 一致しない」も 1 に潰す。後者は申告と矛盾しうるが、前者は**判定不能**
  // （ゲートを一度も走らせていない / 別 worktree で走らせた）であって
  // 「申告が嘘」ではない。ファイルの有無を先に見て 3 を返し、`unknown` へ倒す。
  //
  // ライブラリのパスは `$1` で渡す。文字列へ埋め込むと、パスに `$(...)` や `"` が
  // 混ざったときにシェルが解釈してしまう（このスクリプトの置き場所は固定なので
  // 現実の危険は薄いが、埋め込みが壊れると**失敗が exit 2 = 判定不能**に化けて
  // 裏取りが静かに無効化される）。
  const probe = '. "$1" && f="$(gate_stamp_file)" || exit 2; [ -f "$f" ] || exit 3; gate_stamp_satisfies fast';
  // 🔴 **cwd を repo root へ固定する。** `gate_tree_fingerprint` は `git ls-files` を
  // プロセスの cwd に対して実行するので、`infra/` などから起動すると
  // `quality-gate.sh`（cd root 後に記録する）と指紋が食い違い、**記録があるのに
  // 偽の FAIL** になる。`scripts/aws-cloud-deploy.sh` が同じ罠を既に踏んで直している。
  const result = spawnSync('bash', ['-c', probe, 'gate-stamp-probe', lib], { cwd: root, stdio: 'ignore' });
  // 起動自体に失敗（bash が無い等）したら判定不能。落とす側へ倒さない。
  if (result.error !== undefined) return 'unknown';
  probeExit = result.status;
  return verdictFromExitCode(result.status);
}

// 裏取りが要るかを決めるのは純関数側。ここは読み方だけを渡す（`green` 以外では呼ばれない）。
const check = checkLocalFastGateDeclaration(input.localFastGate, readStampVerdict);
if (check.message !== undefined) {
  // **注意は stderr へ。** stdout は委譲プロンプト本文で、混ざると指示として送られる。
  // probe は git 外(2) と記録なし(3) を区別しているので、人へ渡す文でも潰さない。
  const cause =
    probeExit === 2 ? '（probe exit=2: git リポジトリの外）' : probeExit === 3 ? '（probe exit=3: 記録がまだ無い）' : '';
  console.error(`${check.ok ? '⚠' : '❌'} ${check.message}${cause}`);
}
if (!check.ok) process.exit(1);

try {
  // 🔴 **裏取りの結果は spec ではなくここから渡す。** 本文が「裏取り済み」と
  // 「裏取りできなかった」を区別しないと、記録が無い環境（新しい worktree では常態）で
  // #705 の事象が無傷で通る（#711 レビュー MAJOR-1）。
  console.log(buildDelegationPrompt(input, check.verdict === 'satisfied' ? 'verified' : 'unverified'));
} catch (e) {
  console.error(`プロンプトを組み立てられませんでした: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

// **送信側への注意は stdout ではなく stderr へ。** 本文にリマインダが混ざると
// routine への指示として送られてしまう。
console.error('');
console.error('▶ 送信時に忘れないこと: RemoteTrigger で作成した直後に clear_mcp_connections を呼ぶ');
console.error('  （作成直後は接続済み MCP コネクタが全部自動アタッチされる — CLAUDE.md）');
