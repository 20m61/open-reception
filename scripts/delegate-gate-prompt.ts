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
function readStampVerdict(): StampVerdict {
  const lib = join(import.meta.dirname, 'lib', 'gate-stamp.sh');
  // 🔴 **「記録がまだ無い」と「別ツリーの記録しかない」を区別する。**
  // `gate_stamp_satisfies` はどちらも 1（満たさない）に潰すが、前者は**判定不能**
  // （ゲートを一度も走らせていない / 別 worktree で走らせた）であって
  // 「申告が嘘」ではない。3 を返して `unknown` へ倒す。
  const probe = `. "${lib}" && f="$(gate_stamp_file)" || exit 2; [ -f "$f" ] || exit 3; gate_stamp_satisfies fast`;
  const result = spawnSync('bash', ['-c', probe], { stdio: 'ignore' });
  // 起動自体に失敗（bash が無い等）したら判定不能。落とす側へ倒さない。
  if (result.error !== undefined) return 'unknown';
  return verdictFromExitCode(result.status);
}

const check = checkLocalFastGateDeclaration(input.localFastGate, readStampVerdict());
if (check.message !== undefined) {
  // **注意は stderr へ。** stdout は委譲プロンプト本文で、混ざると指示として送られる。
  console.error(`${check.ok ? '⚠' : '❌'} ${check.message}`);
}
if (!check.ok) process.exit(1);

try {
  console.log(buildDelegationPrompt(input));
} catch (e) {
  console.error(`プロンプトを組み立てられませんでした: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

// **送信側への注意は stdout ではなく stderr へ。** 本文にリマインダが混ざると
// routine への指示として送られてしまう。
console.error('');
console.error('▶ 送信時に忘れないこと: RemoteTrigger で作成した直後に clear_mcp_connections を呼ぶ');
console.error('  （作成直後は接続済み MCP コネクタが全部自動アタッチされる — CLAUDE.md）');
