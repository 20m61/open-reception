#!/usr/bin/env node
/**
 * Broker-side runner for the sparse deploy ledger (#1153 wiring, #1146 arming work).
 *
 * The broker stack publishes this file and `sparse-ledger.mjs` as assets and the broker verifies
 * both files' SHA-256 before running them (the same control as the trusted policy). Candidate code
 * never supplies either file.
 *
 * DynamoDB is reached through the AWS CLI already present in the broker image (no SDK install):
 * each call is `aws dynamodb <operation> --cli-input-json file://<private request file>` via
 * execFileSync (no shell). The request JSON is exactly the low-level API request that
 * sparse-ledger.mjs builds.
 *
 * Subcommands (all read the attempt from the CodeBuild / pipeline environment, never from files
 * the candidate artifact can provide):
 * - `deny --gate-file <path>`: audit a denial before the mutation boundary (S6b: recorded, no
 *   budget). The gate file names the last gate the broker entered; it is written by the stack-owned
 *   buildspec under /tmp, outside the artifact tree. Best-effort, always exits 0: an audit failure
 *   never changes the (already failed) build.
 * - `reserve`: reserve the attempt at the mutation boundary. Exit 0 only when the ledger committed
 *   the reservation; the reservation is written to RESERVATION_PATH for `outcome`. Any denial,
 *   including an unreadable or ambiguous ledger, exits 44 and mutation must not start.
 * - `outcome --outcome succeeded|failed`: record the terminal outcome of the reserved attempt.
 *
 * Every step prints one JSON line `{"event":"ledger.<name>",...}` for the log-based alarms.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RULES, buildDenialPut, isAttemptId, isConditionFailure, isFullSha, recordOutcome, reserveAttempt } from './sparse-ledger.mjs';

export const LEDGER_DIR = '/tmp/open-reception-ledger';
/** Request files live next to this (verified) module: LEDGER_DIR in the broker. */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const RESERVATION_PATH = `${LEDGER_DIR}/reservation.json`;
/** Written before `reserve` touches the ledger: from then on `reserve` owns the attempt's audit. */
export const RESERVE_STARTED_PATH = `${LEDGER_DIR}/reserve-started`;

/** Gates the buildspec can name in the gate file. Anything else is recorded as BROKER_GATE_UNKNOWN. */
export const GATE_RULES = Object.freeze([
  'BROKER_MODULE_INTEGRITY',
  'TRUSTED_PROVENANCE_DENIED',
  'TRUSTED_REVISION_MISMATCH',
  'TRUSTED_POLICY_DENIED',
  'BROKER_NOT_ARMED',
]);
export const UNKNOWN_GATE_RULE = 'BROKER_GATE_UNKNOWN';

const CONDITION_ERRORS = ['TransactionCanceledException', 'ConditionalCheckFailedException'];

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

/**
 * Could the failed call have committed? Only a transport failure or a server-side error can have
 * (CLI exit 255, 5xx / timeouts). Parameter errors (252), configuration errors (253), refused
 * conditions and throttling (4xx, 254) and a CLI that never started cannot. Flags the stuck-attempt
 * alarm without crying wolf.
 */
export function mayHaveCommitted(status, stderr) {
  if (status === 255) return true;
  return /InternalServerError|ServiceUnavailable|RequestTimeout|timed out|Connection (?:was )?(?:closed|reset)|Read timeout/i.test(stderr);
}

/** Run the CLI; return parsed JSON. A failed call throws an Error whose `name` is the service error code when recognisable. */
export const CLI_TIMEOUT_MS = 60 * 1000;

function defaultRunAws(args) {
  let out;
  try {
    out = execFileSync(resolveTool('aws'), [...args, '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, timeout: CLI_TIMEOUT_MS });
  } catch (error) {
    const stderr = String(error?.stderr ?? '');
    const code = CONDITION_ERRORS.find((c) => stderr.includes(`(${c})`));
    const e = new Error(`aws ${args.slice(0, 2).join(' ')} failed${code ? ` (${code})` : ''}`);
    e.name = code ?? 'LedgerCliError';
    // Killed (signal / timeout: status null) after it started: it may have committed.
    const started = error?.code !== 'ENOENT' && error?.code !== 'E2BIG';
    e.maybeCommitted = code ? false : started && (error?.status === null || error?.signal != null || mayHaveCommitted(error?.status, stderr));
    throw e;
  }
  try {
    return out.trim() ? JSON.parse(out) : {};
  } catch {
    // The CLI reported success: the call committed, but its answer is unreadable.
    throw Object.assign(new Error(`aws ${args.slice(0, 2).join(' ')} returned unreadable output`), { name: 'LedgerCliError', maybeCommitted: true });
  }
}

/**
 * The injected-client shape sparse-ledger.mjs expects, backed by the AWS CLI. Each request goes
 * through a private file (`file://`), not argv, so its size (e.g. a long override reason) is not
 * bounded by the argument-length limit.
 */
export function cliClient(runAws = defaultRunAws, { dir = MODULE_DIR } = {}) {
  const call = (operation) => (request) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `request-${randomBytes(8).toString('hex')}.json`);
    fs.writeFileSync(file, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
    try {
      return runAws(['dynamodb', operation, '--cli-input-json', `file://${file}`]);
    } finally {
      fs.rmSync(file, { force: true });
    }
  };
  return {
    transactGetItems: call('transact-get-items'),
    putItem: call('put-item'),
    transactWriteItems: call('transact-write-items'),
  };
}

/** The attempt as the trusted environment defines it. */
export function attemptFromEnv(env = process.env) {
  return {
    table: env.OR_SPARSE_LEDGER_TABLE,
    ledgerId: env.OR_SPARSE_LEDGER_ID,
    revision: env.OR_TRUSTED_SOURCE_REVISION,
    attemptId: env.CODEBUILD_BUILD_ID,
  };
}

const TABLE = /^[A-Za-z0-9_.-]{3,255}$/;

export async function runDeny({ gateFile, client, env = process.env, now = new Date(), readFile = fs.readFileSync, exists = fs.existsSync, reservationPath = RESERVATION_PATH, reserveStartedPath = RESERVE_STARTED_PATH }) {
  const a = attemptFromEnv(env);
  if (exists(reservationPath) || exists(reserveStartedPath)) {
    // `reserve` ran: either the attempt reached the boundary (its only outcomes are succeeded /
    // failed) or `reserve` denied and audited that denial itself with the ledger rule.
    return { event: 'ledger.denial_skipped_reserve_owns_audit', attemptId: a.attemptId };
  }
  let gate;
  try {
    gate = String(readFile(gateFile, 'utf8')).trim();
  } catch {
    gate = '';
  }
  const rule = GATE_RULES.includes(gate) ? gate : UNKNOWN_GATE_RULE;
  if (!TABLE.test(a.table ?? '') || !isAttemptId(a.attemptId)) {
    return { event: 'ledger.denial_audit_failed', rule, attemptId: a.attemptId ?? null, why: 'ledger table or attempt id missing' };
  }
  const base = { rule, attemptId: a.attemptId, revision: a.revision ?? null };
  try {
    await client.putItem(buildDenialPut({ table: a.table, attemptId: a.attemptId, revision: isFullSha(a.revision) ? a.revision : undefined, rule, now }));
    return { event: 'ledger.denial_recorded', ...base };
  } catch (error) {
    // The attempt record is create-only: a refusal means this attempt is already recorded.
    return { event: isConditionFailure(error) ? 'ledger.denial_already_recorded' : 'ledger.denial_audit_failed', ...base };
  }
}

export async function runReserve({ client, env = process.env, now = new Date(), writeFile = fs.writeFileSync, mkdir = fs.mkdirSync, reservationPath = RESERVATION_PATH, reserveStartedPath = RESERVE_STARTED_PATH }) {
  const a = attemptFromEnv(env);
  if (!TABLE.test(a.table ?? '')) {
    return { exitCode: 44, line: { event: 'ledger.reserve_denied', rule: RULES.LEDGER_UNAVAILABLE, reason: 'ledger table not configured' } };
  }
  try {
    mkdir(path.dirname(reserveStartedPath), { recursive: true });
    writeFile(reserveStartedPath, String(a.attemptId ?? ''), { flag: 'wx' });
  } catch {
    // A second `reserve` in one build, or an unwritable marker: never reserve twice.
    return { exitCode: 44, line: { event: 'ledger.reserve_denied', rule: RULES.LEDGER_CONFLICT, reason: 'reserve already started in this build (or its marker could not be written)', attemptId: a.attemptId ?? null } };
  }
  const decision = await reserveAttempt({ client, table: a.table, ledgerId: a.ledgerId, revision: a.revision, attemptId: a.attemptId, now });
  if (decision.result !== 'allowed') {
    return {
      exitCode: 44,
      line: {
        event: decision.ambiguous ? 'ledger.reserve_ambiguous' : 'ledger.reserve_denied',
        rule: decision.rule,
        reason: decision.reason,
        attemptId: a.attemptId ?? null,
        revision: a.revision ?? null,
        day: decision.day ?? null,
        audited: decision.audited ?? false,
      },
    };
  }
  const reservation = {
    attemptId: decision.attemptId,
    revision: decision.revision,
    day: decision.day,
    timezone: decision.timezone,
    mode: decision.mode,
    attemptNumber: decision.attemptNumber,
    reservedAt: now.toISOString(),
    ...(decision.override ? { override: { approver: decision.override.approver, reason: decision.override.reason, expiresAt: decision.override.expiresAt } } : {}),
  };
  // The reservation is committed in the ledger; failing to write this local copy only means the
  // outcome cannot be recorded by this build (the attempt stays in_progress and is alerted on).
  try {
    mkdir(path.dirname(reservationPath), { recursive: true });
    writeFile(reservationPath, JSON.stringify(reservation), { flag: 'wx' });
  } catch {
    return { exitCode: 44, line: { event: 'ledger.reserve_ambiguous', rule: RULES.LEDGER_UNAVAILABLE, reason: 'reserved in the ledger but the local reservation record could not be written; mutation must not start', attemptId: decision.attemptId } };
  }
  return { exitCode: 0, line: { event: 'ledger.reserved', ...reservation } };
}

export async function runOutcome({ client, outcome, env = process.env, now = new Date(), readFile = fs.readFileSync, reservationPath = RESERVATION_PATH }) {
  const a = attemptFromEnv(env);
  let reservation;
  try {
    reservation = JSON.parse(String(readFile(reservationPath, 'utf8')));
  } catch {
    return { exitCode: 45, line: { event: 'ledger.outcome_failed', why: 'no reservation for this attempt', attemptId: a.attemptId ?? null } };
  }
  if (reservation?.attemptId !== a.attemptId) {
    return { exitCode: 45, line: { event: 'ledger.outcome_failed', why: 'reservation belongs to another attempt', attemptId: a.attemptId ?? null } };
  }
  try {
    await recordOutcome({ client, table: a.table, attemptId: reservation.attemptId, day: reservation.day, outcome, now });
    return { exitCode: 0, line: { event: 'ledger.outcome_recorded', outcome, attemptId: reservation.attemptId, day: reservation.day, revision: reservation.revision } };
  } catch (error) {
    return { exitCode: 45, line: { event: 'ledger.outcome_failed', outcome, attemptId: reservation.attemptId, day: reservation.day, why: error instanceof Error ? error.name : 'unknown' } };
  }
}

async function main(argv) {
  const [command, ...rest] = argv;
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const client = cliClient();
  let result;
  try {
    if (command === 'deny') {
      result = { exitCode: 0, line: await runDeny({ gateFile: flag('--gate-file') ?? '', client }) };
    } else if (command === 'reserve') {
      result = await runReserve({ client });
    } else if (command === 'outcome' && ['succeeded', 'failed'].includes(flag('--outcome'))) {
      result = await runOutcome({ client, outcome: flag('--outcome') });
    } else {
      result = { exitCode: 2, line: { event: 'ledger.usage_error', argv } };
    }
  } catch (error) {
    // Nothing above should throw; if it does, a reservation must not be assumed.
    result = { exitCode: command === 'deny' ? 0 : 44, line: { event: 'ledger.runner_error', command, why: error instanceof Error ? error.message : String(error) } };
  }
  process.stdout.write(`${JSON.stringify(result.line)}\n`);
  process.exitCode = result.exitCode;
}

/**
 * Run as a program even when invoked through a symlinked path. Comparing un-resolved paths would
 * silently skip main() and exit 0, which for `reserve` would read as "reserved".
 */
const invokedDirectly = () => {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  await main(process.argv.slice(2));
}
