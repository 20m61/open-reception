#!/usr/bin/env node
/**
 * Target-stack stability gate for the trusted dev-deploy broker (#1146 / #1153, Foundation
 * safe-dev-deploy S10a: "a failed-rollback environment blocks further automated attempts").
 *
 * Before the mutation boundary the broker reads the current status of every stack the promotion
 * may change. An automated attempt may proceed only when each stack either does not exist yet or
 * is in a settled state from which CloudFormation accepts a new update. Anything else — an
 * operation in progress, a failed rollback (`UPDATE_ROLLBACK_FAILED`), a failed create that must
 * be deleted first (`ROLLBACK_COMPLETE`), any `*_FAILED` — is TARGET_STACK_NOT_STABLE and needs a
 * human. The denial is audited in the ledger (S6b: recorded, no budget) and alerted.
 *
 * The decision (`evaluateStacks`) is a pure function over what DescribeStacks returned, so it is
 * tested offline. The CLI reads each stack with the AWS CLI (execFileSync, no shell) and fails
 * closed on anything it cannot classify: an unreadable status is a denial, not "missing".
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TARGET_STACKS_VERSION = 1;
export const BROKER_OUT_DIR = '/tmp/open-reception-broker-out';
export const DECISION_PATH = `${BROKER_OUT_DIR}/target-stacks.json`;
export const CLI_TIMEOUT_MS = 60 * 1000;
export const DENIED_EXIT_CODE = 46;

/** Settled states from which a new automated update may start. Everything else is denied. */
export const STABLE_STATUSES = Object.freeze([
  'CREATE_COMPLETE',
  'UPDATE_COMPLETE',
  'UPDATE_ROLLBACK_COMPLETE',
  'IMPORT_COMPLETE',
  'IMPORT_ROLLBACK_COMPLETE',
]);

export const RULES = Object.freeze({
  NOT_STABLE: 'TARGET_STACK_NOT_STABLE',
  UNVERIFIABLE: 'TARGET_STACK_UNVERIFIABLE',
  INPUT_INVALID: 'TARGET_STACK_INPUT_INVALID',
});

const STACK_NAME = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-[0-9]$/;

const deny = (rule, reason, stacks = []) => ({ version: TARGET_STACKS_VERSION, result: 'denied', rule, reason, stacks });

/**
 * `--stacks A,B,C@us-east-1`: a stack without `@region` is read in `defaultRegion` (the broker's
 * own region, injected by the stack). Names and regions are validated; duplicates are refused.
 */
export function parseStacks(spec, defaultRegion) {
  if (typeof spec !== 'string' || !spec) throw new Error('--stacks missing');
  if (typeof defaultRegion !== 'string' || !REGION.test(defaultRegion)) throw new Error('default region missing or invalid');
  const seen = new Set();
  return spec.split(',').map((entry) => {
    const [stackName, region = defaultRegion, extra] = entry.split('@');
    if (extra !== undefined || !STACK_NAME.test(stackName ?? '') || !REGION.test(region)) throw new Error(`invalid stack entry: ${entry}`);
    const id = `${region}/${stackName}`;
    if (seen.has(id)) throw new Error(`duplicate stack entry: ${entry}`);
    seen.add(id);
    return { stackName, region };
  });
}

/**
 * Pure decision. `observed[i]` is `{ missing: true }` or `{ status: <StackStatus> }` for
 * `targets[i]`. A stack that does not exist yet is allowed (the promotion creates it).
 */
export function evaluateStacks(targets, observed) {
  if (!Array.isArray(targets) || targets.length === 0 || !Array.isArray(observed) || observed.length !== targets.length) {
    return deny(RULES.INPUT_INVALID, 'target stack list missing or not matched by observations');
  }
  const stacks = targets.map((t, i) => {
    const o = observed[i];
    if (o && o.missing === true && o.status === undefined) return { ...t, status: null };
    return { ...t, status: o && typeof o.status === 'string' ? o.status : undefined };
  });
  const unreadable = stacks.filter((s) => s.status === undefined);
  if (unreadable.length > 0) {
    return deny(RULES.UNVERIFIABLE, `status of ${unreadable.map((s) => s.stackName).join(', ')} could not be read`, stacks.map((s) => ({ ...s, status: s.status ?? 'UNKNOWN' })));
  }
  const unstable = stacks.filter((s) => s.status !== null && !STABLE_STATUSES.includes(s.status));
  if (unstable.length > 0) {
    return deny(
      RULES.NOT_STABLE,
      `target stack not in a settled state: ${unstable.map((s) => `${s.region}/${s.stackName}=${s.status}`).join(', ')}; a human must resolve it before another automated attempt (S10a)`,
      stacks,
    );
  }
  return { version: TARGET_STACKS_VERSION, result: 'allowed', rule: null, reason: null, stacks };
}

// --- CLI ------------------------------------------------------------------------------------

/**
 * Resolve a tool from the ABSOLUTE entries of PATH only: the broker's working directory is the
 * candidate tree, so an empty or relative PATH entry must never resolve `aws` there.
 */
export function resolveTool(name, pathValue = process.env.PATH ?? '') {
  for (const dir of pathValue.split(':')) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  throw new Error(`${name} not found on an absolute PATH entry`);
}

/** Run the CLI; `{ ok: true, json }` or `{ ok: false, stderr }`. Never throws for a CLI failure. */
function defaultRunAws(args) {
  try {
    const out = execFileSync(resolveTool('aws'), [...args, '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, timeout: CLI_TIMEOUT_MS });
    return { ok: true, json: JSON.parse(out) };
  } catch (error) {
    return { ok: false, stderr: String(error?.stderr ?? (error instanceof Error ? error.message : error)) };
  }
}

/**
 * Read one stack. Only the CLI's exact "does not exist" answer for THIS name counts as missing;
 * any other failure (access denied, throttling, timeout, unparseable output) leaves the status
 * unknown, which denies.
 */
export function observeStack({ stackName, region }, runAws = defaultRunAws) {
  const r = runAws(['cloudformation', 'describe-stacks', '--stack-name', stackName, '--region', region]);
  if (!r || r.ok !== true) {
    const m = String(r?.stderr ?? '').match(/\(ValidationError\) when calling the DescribeStacks operation: Stack with id (\S+) does not exist/);
    return m && m[1] === stackName ? { missing: true } : {};
  }
  const list = r.json?.Stacks;
  if (!Array.isArray(list) || list.length !== 1 || list[0]?.StackName !== stackName || typeof list[0]?.StackStatus !== 'string') return {};
  return { status: list[0].StackStatus };
}

function parseCli(argv, env) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return parseStacks(flag('--stacks'), env.OR_BROKER_TARGET_REGION);
}

/**
 * Decide and write the decision to DECISION_PATH (exclusive create in the broker-owned output
 * dir). Exit 0 only when every target stack is settled or absent.
 */
export function runCli(argv, { now = new Date(), env = process.env, runAws = defaultRunAws, decisionPath = DECISION_PATH } = {}) {
  let decision;
  try {
    const targets = parseCli(argv, env);
    decision = evaluateStacks(targets, targets.map((t) => observeStack(t, runAws)));
  } catch (error) {
    decision = deny(RULES.INPUT_INVALID, `target stacks could not be checked: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = {
    ...decision,
    executionId: env.OR_PIPELINE_EXECUTION_ID ?? null,
    revision: env.OR_TRUSTED_SOURCE_REVISION ?? null,
    decidedAt: now.toISOString(),
  };
  let exitCode = decision.result === 'allowed' ? 0 : DENIED_EXIT_CODE;
  try {
    fs.writeFileSync(decisionPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch {
    exitCode = DENIED_EXIT_CODE; // the decision could not be recorded where the next check reads it
  }
  return { exitCode, record };
}

function main() {
  const { exitCode, record } = runCli(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify({ event: exitCode === 0 ? 'target_stacks.settled' : 'target_stacks.denied', ...record })}\n`);
  process.exitCode = exitCode;
}

/** Run as a program even when invoked through a symlinked path. */
const invokedDirectly = () => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  main();
}
