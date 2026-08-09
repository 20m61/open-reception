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
import { readFileSync } from 'node:fs';
import { buildDelegationPrompt, type DelegationInput } from '../src/domain/governance/delegation-prompt';

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
