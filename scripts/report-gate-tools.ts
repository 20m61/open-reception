#!/usr/bin/env tsx
/**
 * 品質ゲート任意ツールの有無を報告する CLI (#838)。
 *
 * bash（`install_pkgs.sh` / `cursor-cloud-install.sh` / `quality-gate.sh`）が
 * `command -v` とパス存在を観測し、`name=true|false` を argv で渡す。
 * 判定・文言の正本は `src/domain/governance/gate-tooling.ts`。
 *
 * 終了コードは常に 0（SessionStart を落とさない）。欠落は文言で名指しするだけ。
 */
import {
  GATE_OPTIONAL_TOOLS,
  formatGateToolSessionReport,
  type GateOptionalTool,
  type GateToolObservation,
} from '../src/domain/governance/gate-tooling';

function parseArgs(argv: ReadonlyArray<string>): Partial<GateToolObservation> {
  const observed: Partial<GateToolObservation> = {};
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    if (eq === -1) {
      console.error(`gate-tooling: bad arg (want name=true|false): ${arg}`);
      process.exit(2);
    }
    const name = arg.slice(0, eq);
    const value = arg.slice(eq + 1);
    if (!(GATE_OPTIONAL_TOOLS as readonly string[]).includes(name)) {
      console.error(`gate-tooling: unknown tool: ${name}`);
      process.exit(2);
    }
    if (value !== 'true' && value !== 'false') {
      console.error(`gate-tooling: value must be true|false: ${arg}`);
      process.exit(2);
    }
    observed[name as GateOptionalTool] = value === 'true';
  }
  return observed;
}

const observed = parseArgs(process.argv.slice(2));
for (const line of formatGateToolSessionReport(observed)) {
  console.log(line);
}
