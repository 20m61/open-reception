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
 *
 * 🔴 Concurrency cases need an engine with real transaction isolation. moto's
 * `transact_write_items` deep-copies the tables at the start and, when the transaction fails,
 * writes the copies back without a lock, so a losing racer can erase a winner's committed write
 * (lost update). Those cases therefore run only with `LEDGER_TX_ISOLATION=1`, set when the
 * endpoint is DynamoDB Local (verified 2026-09-27) or another engine with DynamoDB's
 * transactional semantics:
 *
 * ```
 * java -Djava.library.path=./DynamoDBLocal_lib -jar DynamoDBLocal.jar -inMemory -port 8000
 * LOCAL_AWS_INTEGRATION=1 LEDGER_TX_ISOLATION=1 AWS_ENDPOINT_URL=http://127.0.0.1:8000 \
 *   npx vitest run test/sparse-dev-deploy-ledger.emulator.test.ts
 * ```
 */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
// Type-only at module load: the SDK is a root devDependency, loaded in beforeAll only when the
// suite is enabled, so `npm --prefix infra ci` alone can still load (and skip) this file.
import type * as DynamoSdk from '@aws-sdk/client-dynamodb';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ENABLED = process.env.LOCAL_AWS_INTEGRATION === '1';
const TX_ISOLATION = process.env.LEDGER_TX_ISOLATION === '1';
const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? 'http://127.0.0.1:4566';
const RUN = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const TABLE = `sparse-ledger-${RUN}`;

type Item = Record<string, AttributeValue>;
type Decision = Record<string, unknown> & { result: string; rule: string | null };
type LedgerClient = {
  transactGetItems(input: unknown): Promise<{ Responses?: Array<{ Item?: Item }> }>;
  putItem(input: unknown): Promise<unknown>;
  transactWriteItems(input: unknown): Promise<unknown>;
};
type Ledger = {
  DAILY_CEILING_RULE: string;
  GENESIS_KEY: string;
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
    accessRestriction?: { state: string };
  }): Promise<Decision>;
  recordOutcome(input: {
    client: LedgerClient;
    table: string;
    attemptId: string;
    day: string;
    outcome: string;
    now: Date;
    revision: string;
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
let TransactGetItemsCommand: typeof DynamoSdk.TransactGetItemsCommand;
let ddb: DynamoDBClient;
let client: LedgerClient;

const LEDGER_ID = `ledger-${RUN}`;
const REV_B = 'd'.repeat(40);
const REV_F = 'e'.repeat(40);
const REV_S10A = '9'.repeat(40);
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

/**
 * A fresh revision per reservation unless a scenario names one: S10a counts unsettled attempts per
 * revision across days, so scenarios about the daily ceiling must not share a revision.
 */
let revSeq = 0;
const freshRev = () => (revSeq += 1).toString(16).padStart(40, 'd');

const reserve = (now: Date, revision = freshRev(), id = attemptId(), accessRestriction?: { state: string }) =>
  L.reserveAttempt({ client, table: TABLE, ledgerId: LEDGER_ID, revision, attemptId: id, now, accessRestriction });

/**
 * D-5: a reserved attempt blocks the whole project until its outcome is recorded, so a scenario
 * records the outcome of every reservation it does not leave open on purpose.
 */
const settle = async (d: Decision, now: Date, outcome: 'succeeded' | 'failed' = 'succeeded') => {
  expect(d.result).toBe('allowed');
  await L.recordOutcome({ client, table: TABLE, attemptId: d.attemptId as string, day: d.day as string, outcome, now, revision: d.revision as string });
  return d;
};
const reserveSettled = async (now: Date, revision = freshRev(), outcome: 'succeeded' | 'failed' = 'succeeded') => settle(await reserve(now, revision), now, outcome);

/** The items the broker reads (both reads), for scenarios that bypass `reserveAttempt`. */
const ledgerState = async (revision: string, now: Date) => {
  const genesisItem = await getItem(L.GENESIS_KEY);
  const last = genesisItem?.lastAttemptId?.S;
  return {
    genesisItem,
    genesisRecheckItem: genesisItem,
    previousAttemptItem: last ? await getItem(`ATTEMPT#${last}`) : undefined,
    dayItem: await getItem(`DAY#${L.ledgerDay(now)}`),
    overrideItem: await getItem(`OVERRIDE#${L.DAILY_CEILING_RULE}#${revision}#${L.ledgerDay(now)}`),
    revisionItem: await getItem(`REV#${revision}`),
  };
};

describe.skipIf(!ENABLED)('sparse deploy ledger × real DynamoDB engine (emulator)', () => {
  beforeAll(async () => {
    const host = new URL(ENDPOINT).hostname;
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
      throw new Error(`refusing non-loopback endpoint ${ENDPOINT}`);
    }
    L = (await import(pathToFileURL(path.resolve(__dirname, '../broker/sparse-ledger.mjs')).href)) as Ledger;
    sdk = await import('@aws-sdk/client-dynamodb');
    ({ CreateTableCommand, GetItemCommand, PutItemCommand, TransactWriteItemsCommand, DeleteItemCommand, TransactGetItemsCommand } = sdk);
    ddb = new sdk.DynamoDBClient({
      endpoint: ENDPOINT,
      region: 'ap-northeast-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      maxAttempts: 1,
    });
    client = {
      transactGetItems: (input) => ddb.send(new TransactGetItemsCommand(input as never)),
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
    // Its own revision: two recorded failures also block that revision (S10a, tested below).
    const a1 = await reserve(now, REV_F);
    expect(a1).toMatchObject({ result: 'allowed', mode: 'normal', attemptNumber: 1 });
    await L.recordOutcome({ client, table: TABLE, attemptId: a1.attemptId as string, day, outcome: 'failed', now, revision: REV_F });
    const a2 = await reserve(now, REV_F);
    expect(a2).toMatchObject({ result: 'allowed', attemptNumber: 2 });
    await L.recordOutcome({ client, table: TABLE, attemptId: a2.attemptId as string, day, outcome: 'failed', now, revision: REV_F });
    // The same revision escalates (S10a, reported first); any other revision meets the ceiling.
    expect(await reserve(now, REV_F)).toMatchObject({ result: 'denied', rule: 'SPARSE_REVISION_REPEATED_FAILURE', retryable: false });
    const a3 = await reserve(now);
    expect(a3).toMatchObject({ result: 'denied', rule: 'SPARSE_DAILY_ATTEMPT_CEILING', retryable: false });
    expect(await counts(day)).toEqual({ attempts: 2, successes: 0, failures: 2 });

    // The next Tokyo day starts from zero (15:00Z boundary).
    const nextDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 15, 0, 0));
    expect(L.ledgerDay(nextDay)).not.toBe(day);
    const b1 = await reserve(nextDay);
    expect(b1).toMatchObject({ result: 'allowed', attemptNumber: 1 });
    await settle(b1, nextDay);
    dayOffset += 1; // nextDay is now used
  });

  it('an in-progress attempt (no outcome yet) already counts, and blocks every next attempt until closed (D-5)', async () => {
    const now = freshNow();
    const day = L.ledgerDay(now);
    const open = await reserve(now);
    expect(open.result).toBe('allowed');
    // Any revision, any profile: the project waits for a human (runbook 10a). Audited, no budget.
    for (const accessRestriction of [undefined, { state: 'verified' }]) {
      const id = attemptId();
      expect(await reserve(now, freshRev(), id, accessRestriction)).toMatchObject({ result: 'denied', rule: 'SPARSE_PREVIOUS_ATTEMPT_UNSETTLED', audited: true });
      expect((await getItem(`ATTEMPT#${id}`))?.denialRule?.S).toBe('SPARSE_PREVIOUS_ATTEMPT_UNSETTLED');
    }
    expect((await counts(day)).attempts).toBe(1);
    // Closed as failed (what runbook 10a does), it still holds its budget.
    await settle(open, now, 'failed');
    await reserveSettled(now);
    expect((await reserve(now)).rule).toBe('SPARSE_DAILY_ATTEMPT_CEILING');
    expect(await counts(day)).toEqual({ attempts: 2, successes: 1, failures: 1 });
  });

  it.runIf(TX_ISOLATION)('concurrent racers never reserve more than the ceiling or share an attempt number', async () => {
    const now = freshNow();
    const day = L.ledgerDay(now);
    const allowed: Decision[] = [];
    for (let round = 0; round < 6; round += 1) {
      const results = await Promise.all(Array.from({ length: 12 }, () => reserve(now)));
      const won = results.filter((r) => r.result === 'allowed');
      // D-5: one attempt at a time; the winner is settled before the next round.
      expect(won.length).toBeLessThanOrEqual(1);
      for (const w of won) await settle(w, now);
      allowed.push(...won);
      for (const r of results) {
        if (r.result === 'denied') {
          // A read cancelled by a concurrent transaction surfaces as UNAVAILABLE (fail closed).
          // CORRUPT here would mean the snapshot read is not isolated, so it is not accepted.
          expect(['SPARSE_LEDGER_CONFLICT', 'SPARSE_DAILY_ATTEMPT_CEILING', 'SPARSE_LEDGER_UNAVAILABLE', 'SPARSE_PREVIOUS_ATTEMPT_UNSETTLED']).toContain(r.rule);
        }
      }
    }
    expect(allowed.length).toBe(2);
    expect(new Set(allowed.map((a) => a.attemptNumber))).toEqual(new Set([1, 2]));
    expect((await counts(day)).attempts).toBe(2);
  });

  it.runIf(TX_ISOLATION)('an override allows exactly one more attempt, only for its revision, once', async () => {
    const rev = freshRev();
    const now = freshNow();
    const day = L.ledgerDay(now);
    // The day's first two attempts are other revisions (an override cannot lift S10a).
    await reserveSettled(now);
    await reserveSettled(now);
    await issueOverride(rev, now);

    // Another revision cannot use it.
    expect((await reserve(now, REV_B)).rule).toBe('SPARSE_DAILY_ATTEMPT_CEILING');

    // Many racers on the right revision: exactly one consumes it.
    const results = await Promise.all(Array.from({ length: 10 }, () => reserve(now, rev)));
    const winners = results.filter((r) => r.result === 'allowed');
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ mode: 'override', attemptNumber: 3 });
    await settle(winners[0]!, now);

    const consumed = await getItem(`OVERRIDE#${L.DAILY_CEILING_RULE}#${rev}#${L.ledgerDay(now)}`);
    expect(consumed?.consumedBy?.S).toBe(winners[0]!.attemptId);
    const audit = await getItem(`ATTEMPT#${winners[0]!.attemptId as string}`);
    expect(audit?.overrideApprover?.S).toBe('owner');
    expect(audit?.mode?.S).toBe('override');

    // Replay after consumption denies.
    expect((await reserve(now, rev)).rule).toBe('SPARSE_DAILY_ATTEMPT_CEILING');
    expect((await counts(day)).attempts).toBe(3);
  });

  it('overrides are create-only: never replaced, so issue / consume history survives', async () => {
    const rev = freshRev();
    const now = freshNow();
    await issueOverride(rev, now);
    await expect(issueOverride(rev, now, { reason: 'replacement' })).rejects.toMatchObject({
      name: 'ConditionalCheckFailedException',
    });
    const later = new Date(now.getTime() + 3601_000);
    expect(L.ledgerDay(later)).toBe(L.ledgerDay(now));
    await expect(issueOverride(rev, later, { reason: 'after expiry' })).rejects.toMatchObject({
      name: 'ConditionalCheckFailedException',
    });
    const kept = await getItem(`OVERRIDE#${L.DAILY_CEILING_RULE}#${rev}#${L.ledgerDay(now)}`);
    expect(kept?.reason?.S).toBe('emulator: third attempt proof');
  });

  it('an empty or replaced table (no genesis) denies instead of reading as a fresh day', async () => {
    const rev = freshRev();
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
    const d = await L.reserveAttempt({ client, table: other, ledgerId: LEDGER_ID, revision: rev, attemptId: attemptId(), now: freshNow() });
    expect(d).toMatchObject({ result: 'denied', rule: 'SPARSE_LEDGER_CORRUPT' });
  });

  it("deleting today's counter after a reservation is detected (genesis lastDay / total)", async () => {
    const now = freshNow();
    await reserveSettled(now);
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

  it("overwriting today's counter with a lower value is detected", async () => {
    const now = freshNow();
    const day = L.ledgerDay(now);
    await reserveSettled(now);
    await reserveSettled(now);
    await ddb.send(
      new PutItemCommand({
        TableName: TABLE,
        Item: {
          PK: { S: 'PROJECT#open-reception' },
          SK: { S: `DAY#${day}` },
          timezone: { S: 'Asia/Tokyo' },
          day: { S: day },
          attemptCount: { N: '0' },
          successCount: { N: '0' },
          failureCount: { N: '0' },
        },
      }),
    );
    expect(await reserve(now)).toMatchObject({ result: 'denied', rule: 'SPARSE_LEDGER_CORRUPT' });
  });

  it('a reservation built on a stale cumulative total is refused by the engine', async () => {
    const rev = freshRev();
    const now = freshNow();
    await reserveSettled(now, rev);
    const decision = L.evaluatePreflight({ revision: rev, attemptId: attemptId(), now, ledgerId: LEDGER_ID, ...(await ledgerState(rev, now)) });
    expect(decision.result).toBe('allowed');
    const stale = { ...decision, observedTotalAttempts: (decision.observedTotalAttempts as number) - 1 };
    await expect(
      ddb.send(new TransactWriteItemsCommand(L.buildReserveTransaction({ table: TABLE, decision: stale, now }) as never)),
    ).rejects.toMatchObject({ name: 'TransactionCanceledException' });
  });

  it('a ceiling denial is audited without consuming budget', async () => {
    const rev = freshRev();
    const now = freshNow();
    await reserveSettled(now);
    await reserveSettled(now);
    const id = attemptId();
    const d = await reserve(now, rev, id);
    expect(d).toMatchObject({ result: 'denied', rule: 'SPARSE_DAILY_ATTEMPT_CEILING', audited: true });
    const audit = await getItem(`ATTEMPT#${id}`);
    expect(audit?.status?.S).toBe('denied_before_mutation');
    expect(audit?.denialRule?.S).toBe('SPARSE_DAILY_ATTEMPT_CEILING');
    expect((await counts(L.ledgerDay(now))).attempts).toBe(2);
  });

  it('an expired override is refused by the engine even if the JS check were skipped', async () => {
    const rev = freshRev();
    const now = freshNow();
    // The day's first two attempts are other revisions (an override cannot lift S10a).
    await reserveSettled(now);
    await reserveSettled(now);
    await issueOverride(rev, now, { expiresAt: epoch(now) + 60 });
    const afterExpiry = new Date(now.getTime() + 61_000);
    expect((await reserve(afterExpiry, rev)).rule).toBe('SPARSE_DAILY_ATTEMPT_CEILING');

    // Bypass the JS check: a transaction decided while the override was live, executed after
    // expiry, must still be refused by the engine's own condition.
    const decision = L.evaluatePreflight({ revision: rev, attemptId: attemptId(), now, ledgerId: LEDGER_ID, ...(await ledgerState(rev, now)) });
    expect(decision.mode).toBe('override');
    await expect(
      ddb.send(new TransactWriteItemsCommand(L.buildReserveTransaction({ table: TABLE, decision, now: afterExpiry }) as never)),
    ).rejects.toMatchObject({ name: 'TransactionCanceledException' });
    expect((await counts(L.ledgerDay(now))).attempts).toBe(2);
  });

  it('a consumed override is refused by the engine even if the JS check were skipped', async () => {
    const rev = freshRev();
    const now = freshNow();
    // The day's first two attempts are other revisions (an override cannot lift S10a).
    await reserveSettled(now);
    await reserveSettled(now);
    await issueOverride(rev, now);
    const stale = L.evaluatePreflight({ revision: rev, attemptId: attemptId(), now, ledgerId: LEDGER_ID, ...(await ledgerState(rev, now)) });
    const third = await reserve(now, rev);
    expect(third.mode).toBe('override');
    await settle(third, now);
    // Replay the stale decision with the genesis, pointer and count it would now observe, so only
    // the override condition can refuse it.
    const genesisNow = await getItem(L.GENESIS_KEY);
    const replay = {
      ...stale,
      observedAttemptCount: 3,
      observedTotalAttempts: Number(genesisNow?.totalAttempts?.N),
      observedLastDay: genesisNow?.lastDay?.S,
      observedLastAttemptId: genesisNow?.lastAttemptId?.S,
    };
    await expect(
      ddb.send(new TransactWriteItemsCommand(L.buildReserveTransaction({ table: TABLE, decision: replay, now }) as never)),
    ).rejects.toMatchObject({ name: 'TransactionCanceledException' });
    expect((await counts(L.ledgerDay(now))).attempts).toBe(3);
  });

  it('S10a: the second unsettled attempt of a revision blocks it, on any day, even against a racing reservation', async () => {
    const d1 = freshNow();
    const a = await reserve(d1, REV_S10A);
    await L.recordOutcome({ client, table: TABLE, attemptId: a.attemptId as string, day: L.ledgerDay(d1), outcome: 'failed', now: d1, revision: REV_S10A });
    // A reservation decided now (one failure: allowed) ...
    const d2 = freshNow();
    const stale = L.evaluatePreflight({ revision: REV_S10A, attemptId: `${RUN}-s10a-stale`, now: d2, ledgerId: LEDGER_ID, ...(await ledgerState(REV_S10A, d2)) });
    expect(stale.result).toBe('allowed');
    // ... loses to the one transient retry that is allowed, and is refused by the engine: the
    // retry, still running, already holds the revision's second slot.
    const b = await reserve(d1, REV_S10A);
    expect(b).toMatchObject({ result: 'allowed' });
    await expect(ddb.send(new TransactWriteItemsCommand(L.buildReserveTransaction({ table: TABLE, decision: stale, now: d2 }) as never))).rejects.toMatchObject({ name: 'TransactionCanceledException' });
    await L.recordOutcome({ client, table: TABLE, attemptId: b.attemptId as string, day: L.ledgerDay(d1), outcome: 'failed', now: d1, revision: REV_S10A });
    // On a fresh day the revision is still blocked; another revision is not.
    const d3 = freshNow();
    expect(await reserve(d3, REV_S10A)).toMatchObject({ result: 'denied', rule: 'SPARSE_REVISION_REPEATED_FAILURE', revisionFailureCount: 2 });
    await settle(await reserve(d3, REV_B), d3);
  });

  it('S10a: attempts that never record an outcome count; a recorded success releases only its own slot', async () => {
    // An attempt that hangs (no outcome) blocks the project (D-5) until a human closes it as
    // failed (runbook 10a); closed, it keeps its revision slot, so two such attempts block the revision.
    const hang = 'b'.repeat(8) + '1'.repeat(32);
    for (let i = 0; i < 2; i += 1) {
      const now = freshNow();
      const h = await reserve(now, hang);
      expect(h.result).toBe('allowed');
      expect((await reserve(now, freshRev())).rule).toBe('SPARSE_PREVIOUS_ATTEMPT_UNSETTLED');
      await settle(h, now, 'failed');
    }
    expect(await reserve(freshNow(), hang)).toMatchObject({ result: 'denied', rule: 'SPARSE_REVISION_REPEATED_FAILURE', revisionUnsettledCount: 2, revisionFailureCount: 2 });

    // succeed, fail, succeed, fail -> blocked: successes do not erase earlier failures.
    const rev = 'c'.repeat(8) + '2'.repeat(32);
    const run = async (outcome: 'succeeded' | 'failed') => {
      const now = freshNow();
      const r = await reserve(now, rev);
      expect(r.result).toBe('allowed');
      await L.recordOutcome({ client, table: TABLE, attemptId: r.attemptId as string, day: L.ledgerDay(now), outcome, now, revision: rev });
    };
    await run('succeeded');
    await run('failed');
    await run('succeeded');
    await run('failed');
    expect(await reserve(freshNow(), rev)).toMatchObject({ result: 'denied', rule: 'SPARSE_REVISION_REPEATED_FAILURE', revisionUnsettledCount: 2, revisionFailureCount: 2 });
    const item = await getItem(`REV#${rev}`);
    expect(item).toMatchObject({ unsettledCount: { N: '2' }, failureCount: { N: '2' } });
  });

  it('an outcome is recorded once; a second or unknown outcome is refused', async () => {
    const rev = freshRev();
    const now = freshNow();
    const day = L.ledgerDay(now);
    const a = await reserve(now, rev);
    await L.recordOutcome({ client, table: TABLE, attemptId: a.attemptId as string, day, outcome: 'succeeded', now, revision: rev });
    await expect(
      L.recordOutcome({ client, table: TABLE, attemptId: a.attemptId as string, day, outcome: 'failed', now, revision: rev }),
    ).rejects.toMatchObject({ name: 'TransactionCanceledException' });
    await expect(
      L.recordOutcome({ client, table: TABLE, attemptId: `${RUN}-never-reserved`, day, outcome: 'succeeded', now, revision: rev }),
    ).rejects.toMatchObject({ name: 'TransactionCanceledException' });
    expect(await counts(day)).toEqual({ attempts: 1, successes: 1, failures: 0 });
  });

  it('an attempt id is used once', async () => {
    const rev = freshRev();
    const now = freshNow();
    const id = attemptId();
    await settle(await reserve(now, rev, id), now);
    // Settled, so only the create-only attempt record can refuse the reuse.
    expect((await reserve(now, rev, id)).rule).toBe('SPARSE_LEDGER_CONFLICT');
    expect((await counts(L.ledgerDay(now))).attempts).toBe(1);
  });

  it('D-5: the genesis pointer follows each reservation and the engine refuses a decision built on a stale one', async () => {
    const now = freshNow();
    const a = await reserve(now);
    const genesis = await getItem(L.GENESIS_KEY);
    expect(genesis).toMatchObject({ lastAttemptId: { S: a.attemptId }, lastRevision: { S: a.revision }, lastCooldownWaived: { BOOL: false } });
    expect(genesis?.lastReservedAt?.S).toBe(now.toISOString());
    expect(await getItem(`ATTEMPT#${a.attemptId as string}`)).toMatchObject({ cooldownWaived: { BOOL: false }, accessProfile: { S: 'not_access_restricted' }, softCeiling: { N: '2' } });
    await settle(a, now);
    const rev = freshRev();
    const decision = L.evaluatePreflight({ revision: rev, attemptId: attemptId(), now, ledgerId: LEDGER_ID, ...(await ledgerState(rev, now)) });
    expect(decision.result).toBe('allowed');
    // Only the pointer is stale: total, day and count are what the engine holds.
    const stale = { ...decision, observedLastAttemptId: `${RUN}-not-the-last` };
    await expect(ddb.send(new TransactWriteItemsCommand(L.buildReserveTransaction({ table: TABLE, decision: stale, now }) as never))).rejects.toMatchObject({ name: 'TransactionCanceledException' });
    expect((await counts(L.ledgerDay(now))).attempts).toBe(1);
  });

  it('D-5 restricted profile: 1 h cooldown, one waiver after a failure for another revision, no chaining, waived attempts consume budget', async () => {
    const verified = { state: 'verified' };
    const t0 = freshNow();
    const day = L.ledgerDay(t0);
    const at = (s: number) => new Date(t0.getTime() + s * 1000);
    const revA = freshRev();
    const a = await reserve(t0, revA, attemptId(), verified);
    expect(a).toMatchObject({ result: 'allowed', accessProfile: 'access_restricted', cooldownWaived: false });
    await settle(a, t0, 'failed');
    // Within the cooldown: the same revision is a retry, not a fix.
    expect(await reserve(at(60), revA, attemptId(), verified)).toMatchObject({ result: 'denied', rule: 'SPARSE_COOLDOWN_ACTIVE' });
    // Not restricted: no cooldown at all (pre-D-5 ceiling semantics).
    const b = await reserve(at(120), freshRev());
    expect(b).toMatchObject({ result: 'allowed', accessProfile: 'not_access_restricted', cooldownWaived: false });
    await settle(b, at(120), 'failed');
    // A fix for the failed attempt skips the cooldown once.
    const c = await reserve(at(180), freshRev(), attemptId(), verified);
    expect(c).toMatchObject({ result: 'allowed', cooldownWaived: true, attemptNumber: 3 });
    expect(await getItem(`ATTEMPT#${c.attemptId as string}`)).toMatchObject({ cooldownWaived: { BOOL: true } });
    expect((await getItem(L.GENESIS_KEY))?.lastCooldownWaived).toEqual({ BOOL: true });
    await settle(c, at(180), 'failed');
    // No chaining: the attempt after a waived one waits out the cooldown.
    expect(await reserve(at(240), freshRev(), attemptId(), verified)).toMatchObject({ result: 'denied', rule: 'SPARSE_COOLDOWN_ACTIVE' });
    const d = await reserve(at(180 + 3600), freshRev(), attemptId(), verified);
    expect(d).toMatchObject({ result: 'allowed', cooldownWaived: false, attemptNumber: 4 });
    await settle(d, at(180 + 3600));
    expect((await counts(day)).attempts).toBe(4);
  });

  it('a pre-boundary denial is audited without consuming budget', async () => {
    const rev = freshRev();
    const now = freshNow();
    const id = attemptId();
    await ddb.send(
      new PutItemCommand(
        L.buildDenialPut({ table: TABLE, attemptId: id, revision: rev, rule: 'TRUSTED_POLICY_DENY', now }) as never,
      ),
    );
    expect((await getItem(`ATTEMPT#${id}`))?.status?.S).toBe('denied_before_mutation');
    expect((await counts(L.ledgerDay(now))).attempts).toBe(0);
  });

  it('an unreachable ledger denies (S6a)', async () => {
    const rev = freshRev();
    const dead = new sdk.DynamoDBClient({
      endpoint: 'http://127.0.0.1:9',
      region: 'ap-northeast-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      maxAttempts: 1,
    });
    const deadClient: LedgerClient = {
      transactGetItems: (input) => dead.send(new TransactGetItemsCommand(input as never)),
      putItem: (input) => dead.send(new PutItemCommand(input as never)),
      transactWriteItems: (input) => dead.send(new TransactWriteItemsCommand(input as never)),
    };
    const d = await L.reserveAttempt({ client: deadClient, table: TABLE, ledgerId: LEDGER_ID, revision: rev, attemptId: attemptId(), now: freshNow() });
    expect(d).toMatchObject({ result: 'denied', rule: 'SPARSE_LEDGER_UNAVAILABLE', audited: false });
    dead.destroy();
  });
});
