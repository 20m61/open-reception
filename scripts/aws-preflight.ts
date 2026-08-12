/**
 * preflight 判定 CLI (spec §5)。
 *
 * `scripts/aws-cloud-deploy.sh` が集めた観測を JSON で受け取り、
 * `src/domain/governance/deploy-preflight.ts` に判定させて印字する。
 * **不一致があれば非ゼロで終わる。**
 */
import { readFileSync } from 'node:fs';
import {
  DEFAULT_PREFLIGHT_REQUIREMENT,
  evaluatePreflight,
  type PreflightObservation,
} from '../src/domain/governance/deploy-preflight';

function main(): void {
  const [jsonPath, minSecondsArg] = process.argv.slice(2);
  if (jsonPath === undefined) {
    console.error('Usage: tsx scripts/aws-preflight.ts <observation-json> [minCredentialSeconds]');
    process.exit(2);
  }
  const observed = JSON.parse(readFileSync(jsonPath, 'utf8')) as PreflightObservation;
  const required = {
    ...DEFAULT_PREFLIGHT_REQUIREMENT,
    minCredentialSeconds:
      minSecondsArg === undefined
        ? DEFAULT_PREFLIGHT_REQUIREMENT.minCredentialSeconds
        : Number(minSecondsArg),
  };
  const verdict = evaluatePreflight(observed, required);
  if (verdict.ok) {
    console.log('  ✅ preflight 全項目 PASS');
    return;
  }
  console.error('  ⛔ preflight 不一致:');
  for (const f of verdict.failures) console.error(`    - ${f.field}: ${f.detail}`);
  process.exit(1);
}

main();
