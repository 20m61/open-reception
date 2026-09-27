/**
 * Sparse dev-deploy attempt ledger (#1153) against a real DynamoDB engine (emulator).
 *
 * The unit test checks decisions and request shapes. What only a real engine can show is that
 * the emitted condition expressions are accepted and actually refuse the losing writer:
 * compare-and-set on the day counter, create-only attempt records, single-use overrides, and
 * concurrent racers. A fake written next to the code would share its assumptions
 * (`CLAUDE.md`「検証の作法」).
 *
 * Emulator-agnostic (MiniStack / Moto / LocalStack): only `AWS_ENDPOINT_URL` is used. Run:
 *
 * ```
 * npm run aws:local:start   # or any DynamoDB emulator
 * LOCAL_AWS_INTEGRATION=1 AWS_ENDPOINT_URL=http://127.0.0.1:4566 \
 *   npx vitest run test/sparse-dev-deploy-ledger.emulator.test.ts   # in infra/
 * ```
 *
 * Without the flag the suite is skipped (the default gate does not change). With the flag, an
 * unreachable endpoint FAILS instead of skipping, so a broken environment cannot read as green.
 * The endpoint must be loopback; this test never talks to real AWS.
 */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
// Type-only at module load: the SDK is a root devDependency, loaded in beforeAll only when the
// suite is enabled, so `npm --prefix infra ci` alone can still load (and skip) this file.
import type * as DynamoSdk from '@aws-sdk/client-dynamodb';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ENABLED = process.env.LOCAL_AWS_INTEGRATION === '1';
const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://127.0.0.1:4566';
const RUN = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const TABLE = `sparse-ledger-${RUN}`;

type Item = Record<string, AttributeValue>;
type Decision = Record<string, unknown> & { result: string; rule: string | null };
type LedgerClient = {
  getItem(input: unknown): Promise<{ Item?: Item }>;
  putItem(input: unknown): Promise<unknown>;
  transactWriteItems(input: unknown): Promise<unknown>;
};
type Ledger = {
  DAILY_CEILING_RULE: string;
  evaluatePreflight(input: Record<string, unknown>): Decision;
  buildReserveTransaction(input: { table: string; decision: Decision; now: Date }): unknown;
  ledgerDay(now: Date): string;
  buildGenesisPut(input: Record<string, unknown>): Record<string, unknown>;
  reserveAttempt(input: {
    client: LedgerClient;
    table: string;
    ledgerId: string;
    revision: string;
    attemptId: string;
    now: Date;
  }): Promise<Decision>;
  recordOutcome(input: {
    client: LedgerClient;
    table: string;
    attemptId: string;
    day: string;
    outcome: string;
    now: Date;
  }): Promise<unknown>;
  buildIssueOverridePut(input: Record<string, unknown>): Record<string, unknown>;
  buildDenialPut(input: Record<string, unknown>): Record<string, unknown>;
};

let L: Ledger;
let sdk: typeof DynamoSdk;
let CreateTableCommand: typeof DynamoSdk.CreateTableCommand;
let GetItemCommand: typeof DynamoSdk.GetItemCommand;
let PutItemCommand: typeof DynamoSdk.PutItemCommand;
let TransactWriteItemsCommand: typeof DynamoSdk.TransactWriteItemsCommand;
let DeleteItemCommand: typeof DynamoSdk.DeleteItemCommand;
let ddb: DynamoDBClient;
let client: LedgerClient;

const LEDGER_ID = `ledger-${RUN}`;
const REV = 'c'.repeat(40);
const REV_B = 'd'.repeat(40);
const epoch = (d: Date) => Math.floor(d.getTime() / 1000);
let seq = 0;
const attemptId = () => `OpenReceptionTrustedDevDeployBroker:${RUN}-${(seq += 1)}`;

/** Each scenario gets its own Tokyo day so scenarios never share a counter. */
let dayOffset = 0;
const freshNow = () => {
  dayOffset += 1;
  return new Date(Date.UTC(2030, 0, 1 + dayOffset, 3, 0, 0));
};

const getItem = async (sk: string) =>
  (await ddb.send(new GetItemCommand({ TableName: TABLE, Key: { PK: { S: 'PROJECT#open-reception' }, SK: { S: sk } }, ConsistentRead: true }))).Item;

const counts = async (day: string) => {
  const item = await getItem(`DAY#${day}`);
  return {
    attempts: Number(item?.attemptCount?.N ?? 0),
    successes: Number(item?.successCount?.N ?? 0),
    failures: Number(item?.failureCount?.N ?? 0),
  };
};

const issueOverride = (revision: string, now: Date, over: Record<string, unknown> = {}) =>
  ddb.send(
    new PutItemCommand(
      L.buildIssueOverridePut({
        table: TABLE,
        revision,
        rule: L.DAILY_CEILING_RULE,
        day: L.ledgerDay(now),
        expiresAt: epoch(now) + 3600,
        reason: 'emulator: third attempt proof',
        approver: 'owner',
        now,
        ...over,
      }) as never,
    ),
  );

const reserve = (now: Date, revision = REV, id = attemptId()) =>
  L.reserveAttempt({ client, table: TABLE, ledgerId: LEDGER_ID, revision, attemptId: id, now });

describe.skipIf(!ENABLED)('sparse deploy ledger × real DynamoDB engine (emulator)', () => {
  beforeAll(async () => {
    const host = new URL(ENDPOINT).hostname;
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
      throw new Error(`refusing non-loopback endpoint ${ENDPOINT}`);
    }
    L = (await import(pathToFileURL(path.resolve(__dirname, '../broker/sparse-ledger.mjs')).href)) as Ledger;
    sdk = await import('@aws-sdk/client-dynamodb');
    ({ CreateTableCommand, GetItemCommand, PutItemCommand, TransactWriteItemsCommand, DeleteItemCommand } = sdk);
    ddb = new sdk.DynamoDBClient({
      endpoint: ENDPOINT,
      region: 'ap-northeast-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      maxAttempts: 1,
    });
    client = {
      getItem: (input) => ddb.send(new GetItemCommand(input as never)),
      putItem: (input) => ddb.send(new PutItemCommand(input as never)),
      transactWriteItems: (input) => ddb.send(new TransactWriteItemsCommand(input as never)),
    };
    await ddb.send(
      new CreateTableCommand({
        TableName: TABLE,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'PK', AttributeType: 'S' },
          { AttributeName: 'SK', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
      }),
    );
    await ddb.send(new PutItemCommand(L.buildGenesisPut({ table: TABLE, ledgerId: LEDGER_ID, now: new Date() }) as never));
  }, 60_000);

  afterAll(() => ddb?.destroy());

  it('allows two attempts per Tokyo day, then denies; failures consume budget', async () => {
    const now = freshNow();
    const day = L.ledgerDay(now);
    const a1 = await reserve(now);
    expect(a1).toMatchObject({ result: 'allowed', mode: 'normal', attemptNumber: 1 });
    await L.recordOutcome({ client, table: TABLE, attemptId: a1.attemptId as string, day, outcome: 'failed', now });
    const a2 = await reserve(now);
    expect(a2).toMatchObject({ result: 'allowed', attemptNumber: 2 });
    await L.recordOutcome({ client, table: TABLE, attemptId: a2.attemptId as string, day, outcome: 'failed', now });
    const a3 = await reserve(now);
    expect(a3).toMatchObject({ result: 'denied', rule: 'SPARSE_DAILY_ATTEMPT_CEILING', retryable: false });
    expect(await counts(day)).toEqual({ attempts: 2, successes: 0, failures: 2 });

    // The next Tokyo day starts from zero (15:00Z boundary).
    const nextDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 15, 0, 0));
    expect(L.ledgerDay(nextDay)).not.toBe(day);
    const b1 = await reserve(nextDay);
    expect(b1).toMatchObject({ result: 'allowed', attemptNumber: 1 });
    dayOffset += 1; // nextDay is now used
  });

  it('an in-progress attempt (no outcome yet) already counts', async () => {
    const now = freshNow();
    expect((await reserve(now)).result).toBe('allowed');
    expect((await reserve(now)).result).toBe('allowed');
    expect((await reserve(now)).result).toBe('denied');
  });

  it('concurrent racers never reserve more than the ceiling or share an attempt number', async () => {
    const now = freshNow();
    const day = L.ledgerDay(now);
    const allowed: Decision[] = [];
    for (let round = 0; round < 6; round += 1) {
      const results = await Promise.all(Array.from({ length: 12 }, () => reserve(now)));
      allowed.push(...results.filter((r) => r.result === 'allowed'));
      for (const r of results) {
        if (r.result === 'denied') {
          expect(['SPARSE_LEDGER_CONFLICT', 'SPARSE_DAILY_ATTEMPT_CEILING']).toContain(r.rule);
        }
      }
    }
    expect(allowed.length).toBe(2);
    expect(new Set(allowed.map((a) => a.attemptNumber))).toEqual(new Set([1, 2]));
    expect((await counts(day)).attempts).toBe(2);
  });

  it('an override allows exactly one more attempt, only for its revision, once', async () => {
    const now = freshNow();
    const day = L.ledgerDay(now);
    await reserve(now);
    await reserve(now);
    await issueOverride(REV, now);

    // Another revision cannot use it.
    expect((await reserve(now, REV_B)).rule).toBe('SPARSE_DAILY_ATTEMPT_CEILING');

    // Many racers on the right revision: exactly one consumes it.
    const results = await Promise.all(Array.from({ length: 10 }, () => reserve(now)));
    const winners = results.filter((r) => r.result === 'allowed');
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ mode: 'override', attemptNumber: 3 });

    const consumed = await getItem(`OVERRIDE#${L.DAILY_CEILING_RULE}#${REV}#${L.ledgerDay(now)}`);
    expect(consumed?.consumedBy?.S).toBe(winners[0]!.attemptId);
    const audit = await getItem(`ATTEMPT#${winners[0]!.attemptId as string}`);
    expect(audit?.overrideApprover?.S).toBe('owner');
    expect(audit?.mode?.S).toBe('override');

    // Replay after consumption denies.
    expect((await reserve(now)).rule).toBe('SPARSE_DAILY_ATTEMPT_CEILING');
    expect((await counts(day)).attempts).toBe(3);
  });

  it('overrides are create-only: never replaced, so issue / consume history survives', async () => {
    const now = freshNow();
    await issueOverride(REV, now);
    await expect(issueOverride(REV, now, { reason: 'replacement' })).rejects.toMatchObject({
      name: 'ConditionalCheckFailedException',
    });
    const later = new Date(now.getTime() + 3601_000);
    expect(L.ledgerDay(later)).toBe(L.ledgerDay(now));
    await expect(issueOverride(REV, later, { reason: 'after expiry' })).rejects.toMatchObject({
      name: 'ConditionalCheckFailedException',
    });
    const kept = await getItem(`OVERRIDE#${L.DAILY_CEILING_RULE}#${REV}#${L.ledgerDay(now)}`);
    expect(kept?.reason?.S).toBe('emulator: third attempt proof');
  });

  it('an empty or replaced table (no genesis) denies instead of reading as a fresh day', async () => {
    const other = `sparse-ledger-empty-${RUN}`;
    await ddb.send(
      new CreateTableCommand({
        TableName: other,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'PK', AttributeType: 'S' },
          { AttributeName: 'SK', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
      }),
    );
    const d = await L.reserveAttempt({ client, table: other, ledgerId: LEDGER_ID, revision: REV, attemptId: attemptId(), now: freshNow() });
    expect(d).toMatchObject({ result: 'denied', rule: 'SPARSE_LEDGER_CORRUPT' });
  });

  it("deleting today's counter after a reservation is detected (genesis lastDay / total)", async () => {
    const now = freshNow();
    expect((await reserve(now)).result).toBe('allowed');
    await ddb.send(
      new DeleteItemCommand({
        TableName: TABLE,
        Key: { PK: { S: 'PROJECT#open-reception' }, SK: { S: `DAY#${L.ledgerDay(now)}` } },
      }),
    );
    expect(await reserve(now)).toMatchObject({ result: 'denied', rule: 'SPARSE_LEDGER_CORRUPT' });
    const genesis = await getItem('META#genesis');
    expect(genesis?.lastDay?.S).toBe(L.ledgerDay(now));
  });

  it('a ceiling denial is audited without consuming budget', async () => {
    const now = freshNow();
    await reserve(now);
    await reserve(now);
    const id = attemptId();
    const d = await reserve(now, REV, id);
    expect(d).toMatchObject({ result: 'denied', rule: 'SPARSE_DAILY_ATTEMPT_CEILING', audited: true });
    const audit = await getItem(`ATTEMPT#${id}`);
    expect(audit?.status?.S).toBe('denied_before_mutation');
    expect(audit?.denialRule?.S).toBe('SPARSE_DAILY_ATTEMPT_CEILING');
    expect((await counts(L.ledgerDay(now))).attempts).toBe(2);
  });

  it('an expired override is refused by the engine even if the JS check were skipped', async () => {
    const now = freshNow();
    await reserve(now);
    await reserve(now);
    await issueOverride(REV, now, { expiresAt: epoch(now) + 60 });
    const afterExpiry = new Date(now.getTime() + 61_000);
    expect((await reserve(afterExpiry)).rule).toBe('SPARSE_DAILY_ATTEMPT_CEILING');

    // Bypass the JS check: a transaction decided while the override was live, executed after
    // expiry, must still be refused by the engine's own condition.
    const decision = L.evaluatePreflight({
      revision: REV,
      attemptId: attemptId(),
      now,
      ledgerId: LEDGER_ID,
      genesisItem: await getItem('META#genesis'),
      dayItem: await getItem(`DAY#${L.ledgerDay(now)}`),
      overrideItem: await getItem(`OVERRIDE#${L.DAILY_CEILING_RULE}#${REV}#${L.ledgerDay(now)}`),
    });
    expect(decision.mode).toBe('override');
    await expect(
      ddb.send(new TransactWriteItemsCommand(L.buildReserveTransaction({ table: TABLE, decision, now: afterExpiry }) as never)),
    ).rejects.toMatchObject({ name: 'TransactionCanceledException' });
    expect((await counts(L.ledgerDay(now))).attempts).toBe(2);
  });

  it('a consumed override is refused by the engine even if the JS check were skipped', async () => {
    const now = freshNow();
    await reserve(now);
    await reserve(now);
    await issueOverride(REV, now);
    const stale = L.evaluatePreflight({
      revision: REV,
      attemptId: attemptId(),
      now,
      ledgerId: LEDGER_ID,
      genesisItem: await getItem('META#genesis'),
      dayItem: await getItem(`DAY#${L.ledgerDay(now)}`),
      overrideItem: await getItem(`OVERRIDE#${L.DAILY_CEILING_RULE}#${REV}#${L.ledgerDay(now)}`),
    });
    expect((await reserve(now)).mode).toBe('override');
    // Replay the stale decision with the count it would now observe, so only the override
    // condition can refuse it.
    const replay = { ...stale, observedAttemptCount: 3 };
    await expect(
      ddb.send(new TransactWriteItemsCommand(L.buildReserveTransaction({ table: TABLE, decision: replay, now }) as never)),
    ).rejects.toMatchObject({ name: 'TransactionCanceledException' });
    expect((await counts(L.ledgerDay(now))).attempts).toBe(3);
  });

  it('an outcome is recorded once; a second or unknown outcome is refused', async () => {
    const now = freshNow();
    const day = L.ledgerDay(now);
    const a = await reserve(now);
    await L.recordOutcome({ client, table: TABLE, attemptId: a.attemptId as string, day, outcome: 'succeeded', now });
    await expect(
      L.recordOutcome({ client, table: TABLE, attemptId: a.attemptId as string, day, outcome: 'failed', now }),
    ).rejects.toMatchObject({ name: 'TransactionCanceledException' });
    await expect(
      L.recordOutcome({ client, table: TABLE, attemptId: `${RUN}-never-reserved`, day, outcome: 'succeeded', now }),
    ).rejects.toMatchObject({ name: 'TransactionCanceledException' });
    expect(await counts(day)).toEqual({ attempts: 1, successes: 1, failures: 0 });
  });

  it('an attempt id is used once', async () => {
    const now = freshNow();
    const id = attemptId();
    expect((await reserve(now, REV, id)).result).toBe('allowed');
    expect((await reserve(now, REV, id)).rule).toBe('SPARSE_LEDGER_CONFLICT');
    expect((await counts(L.ledgerDay(now))).attempts).toBe(1);
  });

  it('a pre-boundary denial is audited without consuming budget', async () => {
    const now = freshNow();
    const id = attemptId();
    await ddb.send(
      new PutItemCommand(
        L.buildDenialPut({ table: TABLE, attemptId: id, revision: REV, rule: 'TRUSTED_POLICY_DENY', now }) as never,
      ),
    );
    expect((await getItem(`ATTEMPT#${id}`))?.status?.S).toBe('denied_before_mutation');
    expect((await counts(L.ledgerDay(now))).attempts).toBe(0);
  });

  it('an unreachable ledger denies (S6a)', async () => {
    const dead = new sdk.DynamoDBClient({
      endpoint: 'http://127.0.0.1:9',
      region: 'ap-northeast-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      maxAttempts: 1,
    });
    const deadClient: LedgerClient = {
      getItem: (input) => dead.send(new GetItemCommand(input as never)),
      putItem: (input) => dead.send(new PutItemCommand(input as never)),
      transactWriteItems: (input) => dead.send(new TransactWriteItemsCommand(input as never)),
    };
    const d = await L.reserveAttempt({ client: deadClient, table: TABLE, ledgerId: LEDGER_ID, revision: REV, attemptId: attemptId(), now: freshNow() });
    expect(d).toMatchObject({ result: 'denied', rule: 'SPARSE_LEDGER_UNAVAILABLE', audited: false });
    dead.destroy();
  });
});
