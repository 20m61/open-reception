#!/usr/bin/env tsx
/**
 * 実行レーンの判定 CLI (issue #675)。
 *
 * `scripts/hooks/guard-destructive.sh` から呼ばれ、**そのコマンドをこのホストで
 * 走らせてよいか**を判定する。判定そのものは純関数
 * （`src/domain/governance/execution-lane.ts`・unit test 済み）にあり、ここは I/O だけ。
 *
 * ```bash
 * npx tsx scripts/check-execution-lane.ts "<引用符を落としたコマンド文字列>"
 * ```
 *
 * 終了コード: 0 = このホストで実行してよい / 2 = 止める（理由を stderr へ）。
 *
 * **platform は `OR_LANE_PLATFORM` で差し替えられる。** テストが macOS 上で
 * クラウド（linux）を再現するために要る。既定は `process.platform`。
 */
import {
  classifyCommand,
  describeLaneBlock,
  shouldBlockHere,
} from '../src/domain/governance/execution-lane';

const command = process.argv[2] ?? '';
const platform = process.env.OR_LANE_PLATFORM ?? process.platform;

const verdict = classifyCommand(command);
if (shouldBlockHere(verdict, platform) && verdict.lane === 'local-required') {
  console.error(describeLaneBlock(verdict.rule));
  process.exit(2);
}
process.exit(0);
