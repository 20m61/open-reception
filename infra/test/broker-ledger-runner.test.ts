import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

/**
 * Broker-side ledger runner (#1153 wiring): the CLI-backed client, the denial audit the broker's
 * `finally` runs, and reserve / outcome. Offline cases use a fake CLI; the emulator suite drives
 * the SAME CLI code path against a real DynamoDB engine through a fake `aws` that forwards each
 * `dynamodb <op> --cli-input-json` call to DynamoDB Local (LOCAL_AWS_INTEGRATION=1, loopback only).
 */

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Runner = {
  cliClient: (run?: (args: string[]) => J, o?: { dir?: string }) => { transactGetItems: (r: J) => J; putItem: (r: J) => J; transactWriteItems: (r: J) => J };
  runDeny: (o: J) => Promise<J>;
  runReserve: (o: J) => Promise<{ exitCode: number; line: J }>;
  runOutcome: (o: J) => Promise<{ exitCode: number; line: J }>;
  GATE_RULES: readonly string[];
  mayHaveCommitted: (status: number | undefined, stderr: string) => boolean;
  resolveTool: (name: string, pathValue?: string) => string;
  UNKNOWN_GATE_RULE: string;
};
const RUNNER = resolve(__dirname, '../broker/ledger-runner.mjs');
const LEDGER = resolve(__dirname, '../broker/sparse-ledger.mjs');
let R: Runner;
let L: J;
beforeAll(async () => {
  R = (await import(pathToFileURL(RUNNER).href)) as Runner;
  L = (await import(pathToFileURL(LEDGER).href)) as J;
});

const REV = '0123456789abcdef0123456789abcdef01234567';
const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'or-ledger-runner-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const env = (attemptId: string, table = 'OpenReception-DevDeployBroker-SparseDeployLedgerX-1', extra: J = {}) => ({
  OR_SPARSE_LEDGER_TABLE: table,
  OR_SPARSE_LEDGER_ID: 'ledger-test-0001',
  OR_TRUSTED_SOURCE_REVISION: REV,
  CODEBUILD_BUILD_ID: attemptId,
  ...extra,
});

/** A fake `aws` on PATH: records argv, prints `stdout`, or fails with the CLI's error format. */
const withFakeCli = (script: string, fn: () => void) => {
  const dir = scratch();
  writeFileSync(join(dir, 'aws'), script);
  chmodSync(join(dir, 'aws'), 0o755);
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before}`;
  try {
    fn();
  } finally {
    process.env.PATH = before;
  }
  return dir;
};

describe('cliClient: the exact CLI calls and error classification', () => {
  it('passes the low-level request through a private file (not argv), one call per operation, and removes it', () => {
    const dir = scratch();
    const calls: Array<{ args: string[]; body: string; mode: number }> = [];
    const client = R.cliClient((args) => {
      const file = args[3]!.replace(/^file:\/\//, '');
      calls.push({ args, body: readFileSync(file, 'utf8'), mode: statSync(file).mode & 0o777 });
      return {};
    }, { dir });
    client.putItem({ TableName: 't', Item: {} });
    client.transactGetItems({ TransactItems: [] });
    client.transactWriteItems({ TransactItems: [{ Put: { Item: { reason: { S: 'x'.repeat(300000) } } } }] });
    expect(calls.map((c) => c.args.slice(0, 3))).toEqual([
      ['dynamodb', 'put-item', '--cli-input-json'],
      ['dynamodb', 'transact-get-items', '--cli-input-json'],
      ['dynamodb', 'transact-write-items', '--cli-input-json'],
    ]);
    expect(calls[0]!.body).toBe('{"TableName":"t","Item":{}}');
    expect(calls.every((c) => c.mode === 0o600 && c.args[3]!.startsWith(`file://${dir}/`))).toBe(true);
    expect(calls[2]!.body.length).toBeGreaterThan(300000); // beyond a single-argument limit
    expect(readdirSync(dir)).toEqual([]);
  });

  it('marks only transport / server failures as possibly committed', () => {
    expect(R.mayHaveCommitted(255, '')).toBe(true);
    expect(R.mayHaveCommitted(254, 'An error occurred (InternalServerError) when calling')).toBe(true);
    expect(R.mayHaveCommitted(254, 'Read timeout on endpoint URL')).toBe(true);
    expect(R.mayHaveCommitted(252, 'Parameter validation failed')).toBe(false);
    expect(R.mayHaveCommitted(253, 'Unable to locate credentials')).toBe(false);
    expect(R.mayHaveCommitted(254, 'An error occurred (ThrottlingException) when calling')).toBe(false);
    expect(R.mayHaveCommitted(undefined, 'spawn aws ENOENT')).toBe(false);
  });

  it('resolves the CLI only from absolute PATH entries', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'aws'), '#!/bin/sh\n');
    chmodSync(join(dir, 'aws'), 0o755);
    expect(R.resolveTool('aws', `.::rel:${dir}`)).toBe(join(dir, 'aws'));
    expect(() => R.resolveTool('aws', '.::rel')).toThrow(/absolute PATH/);
  });

  it.each([
    ['TransactionCanceledException', 'TransactWriteItems'],
    ['ConditionalCheckFailedException', 'PutItem'],
  ])('maps the CLI error text for %s to that error name (a refused conditional write)', (code, op) => {
    let caught: Error | undefined;
    withFakeCli(`#!/bin/sh\necho "An error occurred (${code}) when calling the ${op} operation: refused" >&2\nexit 254\n`, () => {
      try {
        R.cliClient(undefined, { dir: scratch() }).putItem({});
      } catch (error) {
        caught = error as Error;
      }
    });
    expect(caught?.name).toBe(code);
    expect(L.isConditionFailure(caught)).toBe(true);
    expect((caught as Error & { maybeCommitted?: boolean }).maybeCommitted).toBe(false);
  });

  it('a CLI that reports success with unreadable output, or is killed, may have committed', () => {
    for (const script of ['#!/bin/sh\necho "not json"\nexit 0\n', '#!/bin/sh\nkill -9 $$\n']) {
      let caught: (Error & { maybeCommitted?: boolean }) | undefined;
      withFakeCli(script, () => {
        try {
          R.cliClient(undefined, { dir: scratch() }).transactWriteItems({});
        } catch (error) {
          caught = error as Error & { maybeCommitted?: boolean };
        }
      });
      expect(caught?.maybeCommitted, script).toBe(true);
    }
  });

  it('any other failure is not a condition failure (unavailable, possibly ambiguous)', () => {
    let caught: Error | undefined;
    withFakeCli('#!/bin/sh\necho "Could not connect to the endpoint URL" >&2\nexit 255\n', () => {
      try {
        R.cliClient(undefined, { dir: scratch() }).transactWriteItems({});
      } catch (error) {
        caught = error as Error;
      }
    });
    expect(caught?.name).toBe('LedgerCliError');
    expect(L.isConditionFailure(caught)).toBe(false);
    expect((caught as Error & { maybeCommitted?: boolean }).maybeCommitted).toBe(true);
  });
});

describe('runDeny: the finally-block audit of the gate that stopped the build', () => {
  const recorder = () => {
    const puts: J[] = [];
    return { puts, client: { putItem: (r: J) => (puts.push(r), {}), transactGetItems: () => ({}), transactWriteItems: () => ({}) } };
  };

  it.each(['TRUSTED_PROVENANCE_DENIED', 'TRUSTED_REVISION_MISMATCH', 'TRUSTED_POLICY_DENIED', 'BROKER_NOT_ARMED'])('records %s as a denial before the mutation boundary', async (gate) => {
    const dir = scratch();
    writeFileSync(join(dir, 'gate'), `${gate}\n`);
    const { puts, client } = recorder();
    const line = await R.runDeny({ reserveStartedPath: join(scratch(), 'reserve-started'), gateFile: join(dir, 'gate'), client, env: env('b:1'), reservationPath: join(dir, 'reservation.json') });
    expect(line).toMatchObject({ event: 'ledger.denial_recorded', rule: gate });
    expect(puts[0]!.Item.status.S).toBe('denied_before_mutation');
    expect(puts[0]!.Item.denialRule.S).toBe(gate);
    expect(puts[0]!.Item.revision.S).toBe(REV);
  });

  it('an unknown, missing or forged gate is recorded as BROKER_GATE_UNKNOWN, never as a chosen rule', async () => {
    const dir = scratch();
    for (const content of [null, 'SPARSE_DAILY_ATTEMPT_CEILING', 'BROKER_NOT_ARMED\nX', '']) {
      if (content !== null) writeFileSync(join(dir, 'gate'), content);
      const { client } = recorder();
      const line = await R.runDeny({ reserveStartedPath: join(scratch(), 'reserve-started'), gateFile: join(dir, content === null ? 'missing' : 'gate'), client, env: env('b:2'), reservationPath: join(dir, 'r.json') });
      expect(line.rule, String(content)).toBe(R.UNKNOWN_GATE_RULE);
    }
  });

  it('does not record a denial once reserve ran (it reserved, or audited its own denial with the ledger rule)', async () => {
    for (const marker of ['reservation.json', 'reserve-started']) {
      const dir = scratch();
      writeFileSync(join(dir, marker), '{}');
      const { puts, client } = recorder();
      const line = await R.runDeny({ gateFile: join(dir, 'gate'), client, env: env('b:3'), reservationPath: join(dir, 'reservation.json'), reserveStartedPath: join(dir, 'reserve-started') });
      expect(line.event, marker).toBe('ledger.denial_skipped_reserve_owns_audit');
      expect(puts).toEqual([]);
    }
  });

  it('reports an already-recorded attempt as such, not as an audit failure', async () => {
    const dir = scratch();
    const refused = { putItem: () => { throw Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' }); }, transactGetItems: () => ({}), transactWriteItems: () => ({}) };
    expect(await R.runDeny({ gateFile: join(dir, 'gate'), client: refused, env: env('b:8'), reservationPath: join(dir, 'r'), reserveStartedPath: join(dir, 's') })).toMatchObject({ event: 'ledger.denial_already_recorded' });
  });

  it('reports (never throws) when the audit cannot be written or is not configured', async () => {
    const dir = scratch();
    const failing = { putItem: () => { throw new Error('down'); }, transactGetItems: () => ({}), transactWriteItems: () => ({}) };
    expect(await R.runDeny({ reserveStartedPath: join(scratch(), 'reserve-started'), gateFile: join(dir, 'gate'), client: failing, env: env('b:4'), reservationPath: join(dir, 'r') })).toMatchObject({ event: 'ledger.denial_audit_failed' });
    const { client } = recorder();
    expect(await R.runDeny({ reserveStartedPath: join(scratch(), 'reserve-started'), gateFile: join(dir, 'gate'), client, env: env('b:5', ''), reservationPath: join(dir, 'r') })).toMatchObject({ event: 'ledger.denial_audit_failed' });
  });
});

describe('runReserve / runOutcome without a ledger engine', () => {
  it('an unreadable ledger denies (exit 44) and writes no reservation', async () => {
    const dir = scratch();
    const down = { transactGetItems: () => { throw new Error('down'); }, putItem: () => ({}), transactWriteItems: () => ({}) };
    const r = await R.runReserve({ client: down, env: env('b:6'), reservationPath: join(dir, 'reservation.json'), reserveStartedPath: join(dir, 'reserve-started') });
    expect(r.exitCode).toBe(44);
    expect(r.line).toMatchObject({ event: 'ledger.reserve_denied', rule: 'SPARSE_LEDGER_UNAVAILABLE' });
    expect(existsSync(join(dir, 'reservation.json'))).toBe(false);
  });

  it('a second reserve in the same build is refused before touching the ledger', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'reserve-started'), 'b:9');
    let touched = false;
    const client = { transactGetItems: () => ((touched = true), {}), putItem: () => ({}), transactWriteItems: () => ({}) };
    const r = await R.runReserve({ client, env: env('b:9'), reservationPath: join(dir, 'reservation.json'), reserveStartedPath: join(dir, 'reserve-started') });
    expect(r).toMatchObject({ exitCode: 44, line: { rule: 'SPARSE_LEDGER_CONFLICT' } });
    expect(touched).toBe(false);
  });

  it('an outcome without this attempt\'s reservation fails (exit 45)', async () => {
    const dir = scratch();
    const client = { transactGetItems: () => ({}), putItem: () => ({}), transactWriteItems: () => ({}) };
    expect((await R.runOutcome({ client, outcome: 'succeeded', env: env('b:7'), reservationPath: join(dir, 'none.json') })).exitCode).toBe(45);
    writeFileSync(join(dir, 'other.json'), JSON.stringify({ attemptId: 'b:other', day: '2026-09-28' }));
    expect((await R.runOutcome({ client, outcome: 'succeeded', env: env('b:7'), reservationPath: join(dir, 'other.json') })).line.why).toMatch(/another attempt/);
  });
});

describe('ambiguity, local record failure and invocation (review F1 / F5 / F6)', () => {
  const genesisOnly = (ledgerId: string, day: string) => ({
    Responses: [
      { Item: { PK: { S: 'PROJECT#open-reception' }, SK: { S: 'META#genesis' }, ledgerId: { S: ledgerId }, timezone: { S: 'Asia/Tokyo' }, totalAttempts: { N: '0' } } },
      {},
      {},
    ],
    day,
  });
  const failingWrite = (error: Error) => ({
    transactGetItems: () => genesisOnly('ledger-test-0001', ''),
    putItem: () => ({}),
    transactWriteItems: () => {
      throw error;
    },
  });

  it('a write that may have committed is ambiguous; one that never reached the service is not', async () => {
    const maybe = Object.assign(new Error('x'), { name: 'LedgerCliError', maybeCommitted: true });
    const never = Object.assign(new Error('x'), { name: 'LedgerCliError', maybeCommitted: false });
    const sdkLike = new Error('socket hang up');
    const at = new Date(Date.UTC(2031, 0, 20, 3));
    for (const [error, ambiguous] of [[maybe, true], [never, false], [sdkLike, true]] as const) {
      const d = await L.reserveAttempt({ client: failingWrite(error), table: 't', ledgerId: 'ledger-test-0001', revision: REV, attemptId: 'b:amb', now: at });
      expect(d, String(ambiguous)).toMatchObject({ result: 'denied', rule: 'SPARSE_LEDGER_UNAVAILABLE', ambiguous });
    }
    const dir = scratch();
    const r = await R.runReserve({ client: failingWrite(maybe), env: env('b:amb2'), now: at, reservationPath: join(dir, 'r.json'), reserveStartedPath: join(dir, 's') });
    expect(r).toMatchObject({ exitCode: 44, line: { event: 'ledger.reserve_ambiguous' } });
  });

  it('a committed reservation whose local record cannot be written still exits 44 (mutation must not start)', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'reservation.json'), 'pre-existing');
    const ok = { transactGetItems: () => genesisOnly('ledger-test-0001', ''), putItem: () => ({}), transactWriteItems: () => ({}) };
    const r = await R.runReserve({ client: ok, env: env('b:local'), now: new Date(Date.UTC(2031, 0, 21, 3)), reservationPath: join(dir, 'reservation.json'), reserveStartedPath: join(dir, 's') });
    expect(r).toMatchObject({ exitCode: 44, line: { event: 'ledger.reserve_ambiguous' } });
    expect(readFileSync(join(dir, 'reservation.json'), 'utf8')).toBe('pre-existing');
  });

  it('runs (and fails closed) when invoked through a symlinked path, instead of a silent exit 0', () => {
    const dir = scratch();
    execFileSync('ln', ['-s', resolve(__dirname, '../broker'), join(dir, 'linked')]);
    let status = 0;
    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, [join(dir, 'linked', 'ledger-runner.mjs'), 'reserve'], { encoding: 'utf8', env: { PATH: '/nonexistent' } as Record<string, string> as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      status = (error as { status: number }).status;
      stdout = String((error as { stdout?: string }).stdout ?? '');
    }
    expect(status).toBe(44);
    expect(JSON.parse(stdout.trim()).event).toMatch(/^ledger\.reserve_/);
  });

  it('an unknown subcommand is a usage error, never success', () => {
    let status = 0;
    try {
      execFileSync(process.execPath, [RUNNER, 'reserve-please'], { env: { PATH: '/nonexistent' } as Record<string, string> as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      status = (error as { status: number }).status;
    }
    expect(status).toBe(2);
  });
});

// ---- Emulator: the CLI code path against a real DynamoDB engine ------------------------------

const ENABLED = process.env.LOCAL_AWS_INTEGRATION === '1';
const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://127.0.0.1:8000';

describe.skipIf(!ENABLED)('ledger runner × real DynamoDB engine through the CLI code path (emulator)', () => {
  const TABLE = `runner-ledger-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const LEDGER_ID = 'runner-ledger-id-0001';
  let fakeDir = '';
  let sdk: J;
  let ddb: J;
  let pathBefore: string | undefined;

  beforeAll(async () => {
    const host = new URL(ENDPOINT).hostname;
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) throw new Error(`refusing non-loopback endpoint ${ENDPOINT}`);
    const require = createRequire(resolve(__dirname, '../../package.json'));
    const sdkPath = require.resolve('@aws-sdk/client-dynamodb');
    sdk = (await import(pathToFileURL(sdkPath).href)) as J;
    ddb = new sdk.DynamoDBClient({ endpoint: ENDPOINT, region: 'ap-northeast-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, maxAttempts: 1 });
    await ddb.send(new sdk.CreateTableCommand({
      TableName: TABLE,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
    }));
    await ddb.send(new sdk.PutItemCommand(L.buildGenesisPut({ table: TABLE, ledgerId: LEDGER_ID, now: new Date() })));
    // A fake `aws` that forwards `dynamodb <op> --cli-input-json <json>` to DynamoDB Local and
    // reports service errors in the real CLI's stderr format.
    fakeDir = mkdtempSync(join(tmpdir(), 'or-fake-aws-'));
    const ops = { 'put-item': 'PutItemCommand', 'transact-get-items': 'TransactGetItemsCommand', 'transact-write-items': 'TransactWriteItemsCommand' };
    writeFileSync(join(fakeDir, 'aws'), [
      '#!/usr/bin/env node',
      `const sdk = require(${JSON.stringify(sdkPath)});`,
      'const [service, op, flag, json] = process.argv.slice(2);',
      `const ops = ${JSON.stringify(ops)};`,
      'if (service !== "dynamodb" || flag !== "--cli-input-json" || !ops[op]) { process.stderr.write("usage"); process.exit(252); }',
      `const c = new sdk.DynamoDBClient({ endpoint: ${JSON.stringify(ENDPOINT)}, region: "ap-northeast-1", credentials: { accessKeyId: "test", secretAccessKey: "test" }, maxAttempts: 1 });`,
      'const body = json.startsWith("file://") ? require("fs").readFileSync(json.slice(7), "utf8") : json;',
      'c.send(new sdk[ops[op]](JSON.parse(body))).then((r) => { delete r.$metadata; process.stdout.write(JSON.stringify(r)); }, (e) => { process.stderr.write(`\\nAn error occurred (${e.name}) when calling the ${ops[op].replace("Command", "")} operation: ${e.message}\\n`); process.exit(254); });',
    ].join('\n'));
    chmodSync(join(fakeDir, 'aws'), 0o755);
    pathBefore = process.env.PATH;
    process.env.PATH = `${fakeDir}:${pathBefore}`;
  }, 60_000);

  afterAll(() => {
    process.env.PATH = pathBefore;
    ddb?.destroy();
    if (fakeDir) rmSync(fakeDir, { recursive: true, force: true });
  });

  const cliDir = mkdtempSync(join(tmpdir(), 'or-ledger-cli-'));
  const tokyoNoon = (offsetDays: number) => new Date(Date.UTC(2031, 0, 10 + offsetDays, 3, 0, 0));
  const getItem = async (sk: string) =>
    (await ddb.send(new sdk.GetItemCommand({ TableName: TABLE, Key: { PK: { S: 'PROJECT#open-reception' }, SK: { S: sk } }, ConsistentRead: true }))).Item as J | undefined;

  it('reserve -> outcome through the CLI path counts the attempt, then the ceiling denies', async () => {
    const now = tokyoNoon(0);
    const day = L.ledgerDay(now);
    const dir = scratch();
    for (const [i, outcome] of [[1, 'failed'], [2, 'succeeded']] as const) {
      const attempt = `OpenReceptionTrustedDevDeployBroker:e2e-${i}`;
      const reservationPath = join(dir, `r${i}.json`);
      const r = await R.runReserve({ client: R.cliClient(undefined, { dir: cliDir }), env: env(attempt, TABLE, { OR_SPARSE_LEDGER_ID: LEDGER_ID }), now, reservationPath, reserveStartedPath: `${reservationPath}.started` });
      expect(r).toMatchObject({ exitCode: 0, line: { event: 'ledger.reserved', attemptNumber: i, day } });
      const o = await R.runOutcome({ client: R.cliClient(undefined, { dir: cliDir }), outcome, env: env(attempt, TABLE), now, reservationPath, reserveStartedPath: `${reservationPath}.started` });
      expect(o).toMatchObject({ exitCode: 0, line: { event: 'ledger.outcome_recorded', outcome } });
    }
    expect((await getItem(`DAY#${day}`))).toMatchObject({ attemptCount: { N: '2' }, successCount: { N: '1' }, failureCount: { N: '1' } });
    const third = await R.runReserve({ client: R.cliClient(undefined, { dir: cliDir }), env: env('OpenReceptionTrustedDevDeployBroker:e2e-3', TABLE, { OR_SPARSE_LEDGER_ID: LEDGER_ID }), now, reservationPath: join(dir, 'r3.json'), reserveStartedPath: join(dir, 'r3.started') });
    expect(third).toMatchObject({ exitCode: 44, line: { event: 'ledger.reserve_denied', rule: 'SPARSE_DAILY_ATTEMPT_CEILING' } });
    // The denial of the third attempt is itself audited (create-only record, no budget).
    expect((await getItem('ATTEMPT#OpenReceptionTrustedDevDeployBroker:e2e-3'))?.status?.S).toBe('denied_before_mutation');
  });

  it('a reused attempt id is refused by the engine (not retried), and a second outcome is refused', async () => {
    const now = tokyoNoon(1);
    const dir = scratch();
    const attempt = 'OpenReceptionTrustedDevDeployBroker:dup';
    const first = await R.runReserve({ client: R.cliClient(undefined, { dir: cliDir }), env: env(attempt, TABLE, { OR_SPARSE_LEDGER_ID: LEDGER_ID }), now, reservationPath: join(dir, 'a.json'), reserveStartedPath: join(dir, 'a.started') });
    expect(first.exitCode).toBe(0);
    const again = await R.runReserve({ client: R.cliClient(undefined, { dir: cliDir }), env: env(attempt, TABLE, { OR_SPARSE_LEDGER_ID: LEDGER_ID }), now, reservationPath: join(dir, 'b.json'), reserveStartedPath: join(dir, 'b.started') });
    expect(again).toMatchObject({ exitCode: 44, line: { rule: 'SPARSE_LEDGER_CONFLICT' } });
    expect((await R.runOutcome({ client: R.cliClient(undefined, { dir: cliDir }), outcome: 'failed', env: env(attempt, TABLE), now, reservationPath: join(dir, 'a.json') })).exitCode).toBe(0);
    expect((await R.runOutcome({ client: R.cliClient(undefined, { dir: cliDir }), outcome: 'succeeded', env: env(attempt, TABLE), now, reservationPath: join(dir, 'a.json') })).exitCode).toBe(45);
  });

  it('a wrong ledger id pin denies as corrupt through the CLI path', async () => {
    const r = await R.runReserve({ client: R.cliClient(undefined, { dir: cliDir }), env: env('OpenReceptionTrustedDevDeployBroker:wrong-id', TABLE, { OR_SPARSE_LEDGER_ID: 'another-ledger-0001' }), now: tokyoNoon(2), reservationPath: join(scratch(), 'r.json'), reserveStartedPath: join(scratch(), 'r.started') });
    expect(r).toMatchObject({ exitCode: 44, line: { rule: 'SPARSE_LEDGER_CORRUPT' } });
  });

  it('the finally deny command records through the CLI path', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'gate'), 'TRUSTED_POLICY_DENIED\n');
    const line = await R.runDeny({ reserveStartedPath: join(scratch(), 'reserve-started'), gateFile: join(dir, 'gate'), client: R.cliClient(undefined, { dir: cliDir }), env: env('OpenReceptionTrustedDevDeployBroker:denied', TABLE), now: tokyoNoon(3), reservationPath: join(dir, 'none') });
    expect(line.event).toBe('ledger.denial_recorded');
    expect((await getItem('ATTEMPT#OpenReceptionTrustedDevDeployBroker:denied'))?.denialRule?.S).toBe('TRUSTED_POLICY_DENIED');
  });

  it('concurrent reservations through the CLI path never exceed the ceiling', async () => {
    const now = tokyoNoon(4);
    const dir = scratch();
    const runs = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        new Promise<{ exitCode: number; line: J }>((done) => {
          // Separate processes, so the engine (not this process) serializes the transactions.
          const script = `import(${JSON.stringify(pathToFileURL(RUNNER).href)}).then(async (R) => { const r = await R.runReserve({ client: R.cliClient(undefined, { dir: ${JSON.stringify(cliDir)} }), env: ${JSON.stringify(env(`OpenReceptionTrustedDevDeployBroker:race-${i}`, TABLE, { OR_SPARSE_LEDGER_ID: LEDGER_ID }))}, now: new Date(${now.getTime()}), reservationPath: ${JSON.stringify(join(dir, `race-${i}.json`))}, reserveStartedPath: ${JSON.stringify(join(dir, `race-${i}.started`))} }); process.stdout.write(JSON.stringify(r)); })`;
          const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env } });
          done(JSON.parse(out));
        }),
      ),
    );
    const allowed = runs.filter((r) => r.exitCode === 0);
    expect(allowed.length).toBeLessThanOrEqual(2);
    const day = L.ledgerDay(now);
    expect(Number((await getItem(`DAY#${day}`))?.attemptCount?.N)).toBe(allowed.length);
  });
});
