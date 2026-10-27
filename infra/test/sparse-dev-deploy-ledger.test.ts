import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Sparse dev-deploy attempt ledger (#1153): pure decisions and request shapes.
 *
 * Real conditional-write semantics (compare-and-set, single-use override, races) are checked
 * against a DynamoDB emulator in `sparse-dev-deploy-ledger.emulator.test.ts`, because a fake
 * written here would share this file's assumptions.
 */

type Attr = { S?: string; N?: string; BOOL?: boolean };
type Item = Record<string, Attr>;
type Decision = Record<string, unknown> & { result: string; rule: string | null };

type Ledger = {
  PROJECT_KEY: string;
  LEDGER_TIMEZONE: string;
  SOFT_ATTEMPT_CEILING: number;
  TARGET_ATTEMPTS_PER_DAY: number;
  DAILY_CEILING_RULE: string;
  MAX_OVERRIDE_TTL_SECONDS: number;
  RULES: Record<string, string>;
  OVERRIDABLE_RULES: readonly string[];
  MAX_FAILURES_PER_REVISION: number;
  ACCESS_PROFILES: Record<string, { name: string; softCeiling: number; cooldownSeconds: number; cooldownWaiver: boolean }>;
  selectAccessProfile(accessRestriction: unknown): { name: string; softCeiling: number; cooldownSeconds: number; cooldownWaiver: boolean };
  ledgerDay(now: Date): string;
  dayKey(day: string): string;
  overrideKey(rule: string, revision: string, day: string): string;
  buildGenesisPut(input: { table: string; ledgerId: string; now: Date }): { Item: Item; ConditionExpression: string };
  evaluatePreflight(input: {
    revision: unknown;
    attemptId: unknown;
    now: Date;
    ledgerId?: unknown;
    genesisItem?: Item;
    dayItem?: Item;
    overrideItem?: Item;
    revisionItem?: Item;
    previousAttemptItem?: Item;
    genesisRecheckItem?: Item;
    accessRestriction?: unknown;
    readError?: boolean;
  }): Decision;
  buildReserveTransaction(input: { table: string; decision: Decision; now: Date }): {
    TransactItems: Array<Record<string, Record<string, unknown>>>;
  };
  buildOutcomeTransaction(input: {
    table: string;
    attemptId: string;
    day: string;
    outcome: string;
    now: Date;
    revision: string;
  }): { TransactItems: Array<Record<string, Record<string, unknown>>> };
  buildDenialPut(input: {
    table: string;
    attemptId: string;
    revision: string;
    rule: string;
    now: Date;
  }): Record<string, unknown>;
  buildIssueOverridePut(input: {
    table: string;
    revision: string;
    rule: string;
    day: string;
    expiresAt: number;
    reason: string;
    approver: string;
    now: Date;
  }): { Item: Item; ConditionExpression: string };
};

let L: Ledger;
beforeAll(async () => {
  L = (await import(pathToFileURL(path.resolve(__dirname, '../broker/sparse-ledger.mjs')).href)) as Ledger;
});

const REV = 'a'.repeat(40);
const REV_B = '0123456789abcdef0123456789abcdef01234567';
const ATTEMPT = 'OpenReceptionTrustedDevDeployBroker:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const NOW = new Date('2026-09-21T03:00:00.000Z'); // 12:00 JST
const DAY = '2026-09-21';
const epoch = (d: Date) => Math.floor(d.getTime() / 1000);
const LEDGER_ID = 'ledger-2026-09-27-0001';
const PREV_ATTEMPT = 'OpenReceptionTrustedDevDeployBroker:00000000-0000-4000-8000-000000000040';
const PREV_REV = 'c'.repeat(40);
/** 01:00 Tokyo on `day`: the previous reservation sits on genesis `lastDay` (readGenesis checks it). */
const reservedOn = (day: string | undefined) =>
  new Date(`${day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '2026-09-20'}T01:00:00+09:00`).toISOString();
/** Genesis after 40 reservations; the D-5 previous-attempt pointer follows `lastDay` unless given. */
const genesisItem = (over: Partial<Item> = {}): Item => ({
  PK: { S: 'PROJECT#open-reception' },
  SK: { S: 'META#genesis' },
  ledgerId: { S: LEDGER_ID },
  timezone: { S: 'Asia/Tokyo' },
  createdAt: { S: '2026-09-01T00:00:00.000Z' },
  totalAttempts: { N: '40' },
  lastDay: { S: '2026-09-20' },
  lastDayAttempts: { N: '1' },
  lastAttemptId: { S: PREV_ATTEMPT },
  lastReservedAt: { S: reservedOn(over.lastDay?.S) },
  lastRevision: { S: PREV_REV },
  lastCooldownWaived: { BOOL: false },
  ...over,
});

/** The ATTEMPT# record the genesis pointer names, as `buildReserveTransaction` wrote it. */
const previousAttemptFor = (g: Item, status = 'succeeded', over: Partial<Item> = {}): Item | undefined =>
  g.lastAttemptId?.S === undefined
    ? undefined
    : {
        PK: { S: 'PROJECT#open-reception' },
        SK: { S: `ATTEMPT#${g.lastAttemptId.S}` },
        attemptId: { S: g.lastAttemptId.S },
        revision: g.lastRevision ?? { S: PREV_REV },
        day: g.lastDay ?? { S: '2026-09-20' },
        timezone: { S: 'Asia/Tokyo' },
        status: { S: status },
        mode: { S: 'normal' },
        attemptNumber: { N: '1' },
        reservedAt: g.lastReservedAt ?? { S: reservedOn(undefined) },
        accessProfile: { S: 'not_access_restricted' },
        cooldownWaived: g.lastCooldownWaived ?? { BOOL: false },
        ...over,
      };

const dayItem = (attempts: number, successes = 0, failures = 0, over: Partial<Item> = {}): Item => ({
  PK: { S: 'PROJECT#open-reception' },
  SK: { S: `DAY#${DAY}` },
  timezone: { S: 'Asia/Tokyo' },
  day: { S: DAY },
  attemptCount: { N: String(attempts) },
  successCount: { N: String(successes) },
  failureCount: { N: String(failures) },
  ...over,
});

const overrideItem = (over: Partial<Item> = {}, revision = REV): Item => ({
  PK: { S: 'PROJECT#open-reception' },
  SK: { S: `OVERRIDE#SPARSE_DAILY_ATTEMPT_CEILING#${revision}#${DAY}` },
  revision: { S: revision },
  rule: { S: 'SPARSE_DAILY_ATTEMPT_CEILING' },
  day: { S: DAY },
  timezone: { S: 'Asia/Tokyo' },
  expiresAt: { N: String(epoch(NOW) + 3600) },
  reason: { S: 'third integration proof for the CloudFront behaviour change' },
  approver: { S: '20m61' },
  issuedAt: { S: '2026-09-21T02:30:00.000Z' },
  ...over,
});

/**
 * The broker's two reads: genesis (with day / override / revision) and then genesis again with the
 * previous attempt's record. By default the previous attempt succeeded and genesis did not move.
 */
const preflight = (over: Partial<Parameters<Ledger['evaluatePreflight']>[0]> = {}) => {
  const g = 'genesisItem' in over ? over.genesisItem : genesisItem();
  return L.evaluatePreflight({
    revision: REV,
    attemptId: ATTEMPT,
    now: NOW,
    ledgerId: LEDGER_ID,
    genesisItem: g,
    genesisRecheckItem: g,
    previousAttemptItem: g ? previousAttemptFor(g) : undefined,
    ...over,
  });
};

describe('policy constants match the owner decision on #1153 and Foundation S6', () => {
  it('counts attempts per Asia/Tokyo day with target 1 and soft ceiling 2', () => {
    expect(L.LEDGER_TIMEZONE).toBe('Asia/Tokyo');
    expect(L.TARGET_ATTEMPTS_PER_DAY).toBe(1);
    expect(L.SOFT_ATTEMPT_CEILING).toBe(2);
    expect(L.PROJECT_KEY).toBe('PROJECT#open-reception');
  });
});

describe('accounting day is the declared Asia/Tokyo calendar day', () => {
  it.each([
    ['2026-09-20T14:59:59.999Z', '2026-09-20'],
    ['2026-09-20T15:00:00.000Z', '2026-09-21'],
    ['2026-12-31T15:00:00.000Z', '2027-01-01'],
    ['2026-09-21T14:59:59.999Z', '2026-09-21'],
  ])('%s -> %s', (iso, day) => {
    expect(L.ledgerDay(new Date(iso))).toBe(day);
  });

  it('does not depend on the process timezone', () => {
    // Every UTC hour of one day maps to at most two Tokyo days, split exactly at 15:00Z.
    for (let h = 0; h < 24; h += 1) {
      const d = new Date(Date.UTC(2026, 8, 20, h, 30));
      expect(L.ledgerDay(d)).toBe(h < 15 ? '2026-09-20' : '2026-09-21');
    }
  });

  it('rejects an invalid clock', () => {
    expect(() => L.ledgerDay(new Date('nope'))).toThrow();
  });
});

describe('preflight: attempt counting (invariant over the whole count range)', () => {
  it('allows without override exactly when fewer than 2 attempts reached the boundary today', () => {
    for (let attempts = 0; attempts <= 6; attempts += 1) {
      for (let successes = 0; successes <= attempts; successes += 1) {
        for (let failures = 0; successes + failures <= attempts; failures += 1) {
          const d = preflight({ dayItem: attempts === 0 ? undefined : dayItem(attempts, successes, failures) });
          if (attempts < 2) {
            expect(d.result, `attempts=${attempts}`).toBe('allowed');
            expect(d.mode).toBe('normal');
            expect(d.observedAttemptCount).toBe(attempts);
          } else {
            // Failures consume budget: 2 failed attempts deny exactly like 2 successes.
            expect(d.result, `attempts=${attempts} s=${successes} f=${failures}`).toBe('denied');
            expect(d.rule).toBe('SPARSE_DAILY_ATTEMPT_CEILING');
            expect(d.retryable).toBe(false);
          }
        }
      }
    }
  });

  it('a missing day item is a fresh day (count 0)', () => {
    const d = preflight({ dayItem: undefined });
    expect(d.result).toBe('allowed');
    expect(d.observedAttemptCount).toBe(0);
    expect(d.day).toBe(DAY);
    expect(d.timezone).toBe('Asia/Tokyo');
  });
});

describe('preflight: S6a fail closed on an unavailable or inconsistent ledger', () => {
  it('denies when the ledger cannot be read, even on a fresh day', () => {
    const d = preflight({ readError: true });
    expect(d.result).toBe('denied');
    expect(d.rule).toBe('SPARSE_LEDGER_UNAVAILABLE');
    expect(d.retryable).toBe(false);
  });

  it.each([
    ['negative count', { attemptCount: { N: '-1' } }],
    ['fractional count', { attemptCount: { N: '1.5' } }],
    ['count as string attribute', { attemptCount: { S: '1' } }],
    ['count with extra type', { attemptCount: { N: '1', S: '1' } as Attr }],
    ['missing attemptCount', { attemptCount: undefined }],
    ['missing failureCount', { failureCount: undefined }],
    ['more outcomes than attempts', { attemptCount: { N: '1' }, successCount: { N: '1' }, failureCount: { N: '1' } }],
    ['undeclared timezone', { timezone: undefined }],
    ['another timezone', { timezone: { S: 'UTC' } }],
    ['day attribute from another day', { day: { S: '2026-09-20' } }],
    ['key from another day', { SK: { S: 'DAY#2026-09-20' } }],
    ['another project', { PK: { S: 'PROJECT#salon-loop' } }],
    ['unsafe integer', { attemptCount: { N: '9007199254740993' } }],
  ])('denies a corrupt day item: %s', (_label, over) => {
    const item = dayItem(1, 0, 0, over as Partial<Item>);
    for (const [k, v] of Object.entries(over)) if (v === undefined) delete item[k];
    const d = preflight({ dayItem: item });
    expect(d.result).toBe('denied');
    expect(d.rule).toBe('SPARSE_LEDGER_CORRUPT');
  });

  it('a corrupt counter is not rescued by a valid override', () => {
    const d = preflight({ dayItem: dayItem(2, 0, 0, { timezone: { S: 'UTC' } }), overrideItem: overrideItem() });
    expect(d.rule).toBe('SPARSE_LEDGER_CORRUPT');
  });
});

describe('preflight: genesis item distinguishes a fresh day from an empty or replaced table', () => {
  it.each([
    ['missing genesis (empty or replaced table)', { genesisItem: undefined }],
    ['genesis of another ledger', { genesisItem: genesisItem({ ledgerId: { S: 'ledger-other-0000' } }) }],
    ['genesis with another timezone', { genesisItem: genesisItem({ timezone: { S: 'UTC' } }) }],
    ['genesis under another key', { genesisItem: genesisItem({ SK: { S: 'META#other' } }) }],
    ['broker has no ledger id', { ledgerId: undefined }],
    ['broker ledger id malformed', { ledgerId: 'x' }],
  ])('denies a fresh day when %s', (_l, over) => {
    const d = preflight({ dayItem: undefined, ...over });
    expect(d.result).toBe('denied');
    expect(d.rule).toBe('SPARSE_LEDGER_CORRUPT');
  });

  it.each([
    ['lastDay after today (clock regression / tampering)', { genesisItem: genesisItem({ lastDay: { S: '2026-09-22' } }) }],
    ['today already reserved but its counter was deleted', { genesisItem: genesisItem({ lastDay: { S: DAY }, lastDayAttempts: { N: '1' } }), dayItem: undefined }],
    ["today's counter overwritten to a lower value", { genesisItem: genesisItem({ lastDay: { S: DAY }, lastDayAttempts: { N: '2' } }), dayItem: dayItem(0) }],
    ["today's counter above genesis", { genesisItem: genesisItem({ lastDay: { S: DAY }, lastDayAttempts: { N: '1' } }), dayItem: dayItem(2) }],
    ['lastDayAttempts missing', { genesisItem: genesisItem({ lastDayAttempts: undefined }) }],
    ['lastDayAttempts above total', { genesisItem: genesisItem({ totalAttempts: { N: '1' }, lastDayAttempts: { N: '2' } }) }],
    ['day counter above the cumulative total', { genesisItem: genesisItem({ totalAttempts: { N: '1' } }), dayItem: dayItem(2) }],
    ['totalAttempts missing', { genesisItem: genesisItem({ totalAttempts: undefined }) }],
    ['lastDay malformed', { genesisItem: genesisItem({ lastDay: { S: 'yesterday' } }) }],
    ['lastDay without any attempt', { genesisItem: genesisItem({ totalAttempts: { N: '0' } }) }],
    ['attempts without lastDay', { genesisItem: genesisItem({ lastDay: undefined, lastDayAttempts: undefined }) }],
  ])('denies when %s', (_l, over) => {
    const g = (over as { genesisItem?: Item }).genesisItem;
    if (g) for (const [k, v] of Object.entries(g)) if (v === undefined) delete g[k];
    const d = preflight({ dayItem: dayItem(1), ...over });
    expect(d.result).toBe('denied');
    expect(d.rule).toBe('SPARSE_LEDGER_CORRUPT');
  });

  it('a later day with lastDay = yesterday and no counter yet is a fresh day', () => {
    const d = preflight({ dayItem: undefined });
    expect(d).toMatchObject({ result: 'allowed', observedAttemptCount: 0, observedTotalAttempts: 40 });
  });

  it('reservation compare-and-sets the cumulative total and a monotonic lastDay on genesis', () => {
    const tx = L.buildReserveTransaction({ table: 'T', decision: preflight({ dayItem: dayItem(1) }), now: NOW });
    const g = tx.TransactItems[0]!.Update!;
    expect(g.Key).toEqual({ PK: { S: 'PROJECT#open-reception' }, SK: { S: 'META#genesis' } });
    for (const clause of ['#ledgerId = :ledgerId', '#totalAttempts = :observedTotal', '#lastDay < :day']) {
      expect(g.ConditionExpression).toContain(clause);
    }
    expect((g.ExpressionAttributeValues as Item)[':newTotal']).toEqual({ N: '41' });
    expect((g.ExpressionAttributeValues as Item)[':newDayCount']).toEqual({ N: '2' });
  });

  it('a second reservation on the same day also compare-and-sets lastDayAttempts', () => {
    const today = genesisItem({ lastDay: { S: DAY }, lastDayAttempts: { N: '1' } });
    const decision = preflight({ genesisItem: today, dayItem: dayItem(1) });
    expect(decision.result).toBe('allowed');
    const g = L.buildReserveTransaction({ table: 'T', decision, now: NOW }).TransactItems[0]!.Update!;
    expect(g.ConditionExpression).toContain('#lastDay = :day AND #lastDayAttempts = :observedDayCount');
    expect(g.ConditionExpression).toContain('#totalAttempts = :observedTotal');
    expect((g.ExpressionAttributeValues as Item)[':observedDayCount']).toEqual({ N: '1' });
    expect((g.ExpressionAttributeValues as Item)[':newDayCount']).toEqual({ N: '2' });
  });

  it('genesis put is create-only and is accepted by preflight', () => {
    const put = L.buildGenesisPut({ table: 'T', ledgerId: LEDGER_ID, now: NOW });
    expect(put.ConditionExpression).toBe('attribute_not_exists(#PK)');
    expect(preflight({ genesisItem: put.Item }).result).toBe('allowed');
    expect(() => L.buildGenesisPut({ table: 'T', ledgerId: 'short', now: NOW })).toThrow();
  });
});

describe('preflight: trusted inputs', () => {
  it('denies an invalid broker clock instead of throwing', () => {
    expect(preflight({ now: new Date('nope') }).rule).toBe('BROKER_CLOCK_INVALID');
    expect(preflight({ now: undefined as unknown as Date }).rule).toBe('BROKER_CLOCK_INVALID');
  });

  it.each([
    ['short sha', 'a'.repeat(39)],
    ['uppercase sha', 'A'.repeat(40)],
    ['branch name', 'dev-deploy'],
    ['missing', undefined],
  ])('denies an invalid revision (%s) before touching the ledger', (_l, revision) => {
    const d = preflight({ revision, readError: true });
    expect(d.rule).toBe('TRUSTED_REVISION_INVALID');
  });

  it.each([['empty', ''], ['missing', undefined], ['spaces', 'a b'], ['hash char', 'a#b']])(
    'denies an invalid attempt id (%s)',
    (_l, attemptId) => {
      expect(preflight({ attemptId }).rule).toBe('ATTEMPT_ID_INVALID');
    },
  );
});

describe('preflight: S5a override (revision-, rule- and day-bound, single-use, expiring)', () => {
  it('allows a third attempt with a live override for exactly this revision and rule', () => {
    const d = preflight({ dayItem: dayItem(2, 1, 1), overrideItem: overrideItem() });
    expect(d.result).toBe('allowed');
    expect(d.mode).toBe('override');
    expect(d.observedAttemptCount).toBe(2);
    expect(d.override).toMatchObject({ rule: 'SPARSE_DAILY_ATTEMPT_CEILING', revision: REV, approver: '20m61' });
  });

  it('an override is ignored while under the ceiling (it is not consumed by a normal attempt)', () => {
    const d = preflight({ dayItem: dayItem(1), overrideItem: overrideItem() });
    expect(d.mode).toBe('normal');
    expect(d.override).toBeUndefined();
  });

  it.each([
    ['another revision', overrideItem({ revision: { S: REV_B } })],
    ['key for another revision', overrideItem({ SK: { S: `OVERRIDE#SPARSE_DAILY_ATTEMPT_CEILING#${REV_B}#${DAY}` } })],
    ['key for another day', overrideItem({ SK: { S: `OVERRIDE#SPARSE_DAILY_ATTEMPT_CEILING#${REV}#2026-09-20` } })],
    ['another rule', overrideItem({ rule: { S: 'TRUSTED_POLICY_DENY' } })],
    ['yesterday', overrideItem({ day: { S: '2026-09-20' } })],
    ['another timezone', overrideItem({ timezone: { S: 'UTC' } })],
    ['expired exactly now', overrideItem({ expiresAt: { N: String(epoch(NOW)) } })],
    ['expired', overrideItem({ expiresAt: { N: String(epoch(NOW) - 1) } })],
    ['no expiry', overrideItem({ expiresAt: undefined })],
    ['expiry as string', overrideItem({ expiresAt: { S: String(epoch(NOW) + 60) } })],
    ['blank reason', overrideItem({ reason: { S: '   ' } })],
    ['no reason', overrideItem({ reason: undefined })],
    ['blank approver', overrideItem({ approver: { S: ' ' } })],
    ['no approver', overrideItem({ approver: undefined })],
    ['no issue time', overrideItem({ issuedAt: undefined })],
    ['already consumed', overrideItem({ consumedAt: { S: '2026-09-21T02:50:00.000Z' } })],
    ['consumed marker only', overrideItem({ consumedBy: { S: 'other' } })],
    ['another project', overrideItem({ PK: { S: 'PROJECT#salon-loop' } })],
  ])('denies at the ceiling with an unusable override: %s', (_label, item) => {
    for (const [k, v] of Object.entries(item)) if (v === undefined) delete item[k];
    const d = preflight({ dayItem: dayItem(2), overrideItem: item });
    expect(d.result).toBe('denied');
    expect(d.rule).toBe('SPARSE_DAILY_ATTEMPT_CEILING');
  });

  it('one override lifts the ceiling for exactly one more attempt (4th needs another)', () => {
    const third = preflight({ dayItem: dayItem(2), overrideItem: overrideItem() });
    expect(third.result).toBe('allowed');
    // After reservation the override is consumed and the count is 3.
    const fourth = preflight({
      dayItem: dayItem(3),
      overrideItem: overrideItem({ consumedAt: { S: NOW.toISOString() }, consumedBy: { S: ATTEMPT } }),
    });
    expect(fourth.result).toBe('denied');
  });
});

describe('reservation transaction shape', () => {
  const table = 'OpenReceptionSparseDevDeployLedger';

  it('first attempt of the day creates the counter only if absent and writes a create-only attempt record', () => {
    const tx = L.buildReserveTransaction({ table, decision: preflight(), now: NOW });
    expect(tx.TransactItems).toHaveLength(4);
    // S10a: the revision counter is created / guarded in the same transaction.
    const rev = tx.TransactItems[3]!.Update!;
    expect(rev.Key).toEqual({ PK: { S: 'PROJECT#open-reception' }, SK: { S: `REV#${REV}` } });
    expect(rev.ConditionExpression).toBe('(attribute_not_exists(#PK) OR (#revision = :rev AND #unsettledCount < :maxFailures))');
    expect(rev.UpdateExpression).toContain('#unsettledCount = if_not_exists(#unsettledCount, :zero) + :one');
    expect((rev.ExpressionAttributeValues as Item)[':maxFailures']).toEqual({ N: '2' });
    const upd = tx.TransactItems[1]!.Update!;
    expect(upd.Key).toEqual({ PK: { S: 'PROJECT#open-reception' }, SK: { S: `DAY#${DAY}` } });
    expect(upd.ConditionExpression).toBe('attribute_not_exists(#PK)');
    const put = tx.TransactItems[2]!.Put!;
    expect(put.ConditionExpression).toBe('attribute_not_exists(#PK)');
    expect((put.Item as Item).status).toEqual({ S: 'in_progress' });
    expect((put.Item as Item).attemptNumber).toEqual({ N: '1' });
  });

  it('later attempts compare-and-set on the observed count', () => {
    const tx = L.buildReserveTransaction({ table, decision: preflight({ dayItem: dayItem(1, 0, 1) }), now: NOW });
    const upd = tx.TransactItems[1]!.Update!;
    expect(upd.ConditionExpression).toContain('#attemptCount = :observed');
    expect((upd.ExpressionAttributeValues as Item)[':observed']).toEqual({ N: '1' });
  });

  it('an override reservation consumes the override in the same transaction and copies it into the audit record', () => {
    const decision = preflight({ dayItem: dayItem(2), overrideItem: overrideItem() });
    const tx = L.buildReserveTransaction({ table, decision, now: NOW });
    expect(tx.TransactItems).toHaveLength(5);
    const consume = tx.TransactItems[2]!.Update!;
    expect(consume.Key).toEqual({
      PK: { S: 'PROJECT#open-reception' },
      SK: { S: `OVERRIDE#SPARSE_DAILY_ATTEMPT_CEILING#${REV}#${DAY}` },
    });
    for (const clause of ['attribute_not_exists(#consumedAt)', '#revision = :rev', '#rule = :rule', '#day = :day', '#expiresAt > :epoch']) {
      expect(consume.ConditionExpression).toContain(clause);
    }
    const audit = tx.TransactItems[3]!.Put!.Item as Item;
    expect(audit.mode).toEqual({ S: 'override' });
    expect(audit.overrideApprover).toEqual({ S: '20m61' });
    expect(audit.overrideRule).toEqual({ S: 'SPARSE_DAILY_ATTEMPT_CEILING' });
  });

  it('refuses to build a reservation from a denial or an inconsistent decision', () => {
    expect(() => L.buildReserveTransaction({ table, decision: preflight({ readError: true }), now: NOW })).toThrow();
    const normal = preflight({ dayItem: dayItem(1) });
    expect(() =>
      L.buildReserveTransaction({ table, decision: { ...normal, observedAttemptCount: 2 }, now: NOW }),
    ).toThrow();
    expect(() =>
      L.buildReserveTransaction({ table, decision: { ...normal, mode: 'override' }, now: NOW }),
    ).toThrow();
  });

  it('every attribute name in every expression is aliased (DynamoDB reserves e.g. timezone / status / day)', () => {
    const ops = [
      ...[
        preflight(),
        preflight({ dayItem: dayItem(1) }),
        preflight({ dayItem: dayItem(2), overrideItem: overrideItem() }),
        preflight({ genesisItem: genesisItem({ lastDay: { S: DAY }, lastDayAttempts: { N: '1' } }), dayItem: dayItem(1) }),
      ]
        .flatMap((decision) => L.buildReserveTransaction({ table, decision, now: NOW }).TransactItems),
      ...L.buildOutcomeTransaction({ table, attemptId: ATTEMPT, day: DAY, outcome: 'succeeded', now: NOW, revision: REV }).TransactItems,
    ].map((entry) => Object.values(entry)[0]!);
    ops.push(L.buildDenialPut({ table, attemptId: ATTEMPT, revision: REV, rule: 'R', now: NOW }));
    ops.push(
      L.buildIssueOverridePut({
        table, revision: REV, rule: 'SPARSE_DAILY_ATTEMPT_CEILING', day: DAY,
        expiresAt: epoch(NOW) + 60, reason: 'r', approver: 'a', now: NOW,
      }) as unknown as Record<string, unknown>,
    );
    ops.push(L.buildGenesisPut({ table, ledgerId: LEDGER_ID, now: NOW }) as unknown as Record<string, unknown>);
    const KEYWORDS = new Set(['SET', 'AND', 'OR', 'NOT', 'attribute_exists', 'attribute_not_exists', 'if_not_exists']);
    for (const op of ops) {
      const text = `${(op.UpdateExpression as string) ?? ''} ${(op.ConditionExpression as string) ?? ''}`;
      const bare = [...text.matchAll(/(?<![#:A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)/g)]
        .map((m) => m[1]!)
        .filter((w) => !KEYWORDS.has(w));
      expect(bare, text).toEqual([]);
      const names = (op.ExpressionAttributeNames ?? {}) as Record<string, string>;
      for (const m of text.matchAll(/#([A-Za-z][A-Za-z0-9]*)/g)) expect(names[`#${m[1]}`]).toBe(m[1]);
    }
  });

  it('every expression attribute value and name is referenced (DynamoDB rejects unused ones)', () => {
    const decisions = [
      preflight(),
      preflight({ dayItem: dayItem(1) }),
      preflight({ dayItem: dayItem(2), overrideItem: overrideItem() }),
    ];
    const txs = [
      ...decisions.map((decision) => L.buildReserveTransaction({ table, decision, now: NOW })),
      L.buildOutcomeTransaction({ table, attemptId: ATTEMPT, day: DAY, outcome: 'failed', now: NOW, revision: REV }),
    ];
    for (const tx of txs) {
      for (const entry of tx.TransactItems) {
        const op = Object.values(entry)[0]!;
        const text = `${op.UpdateExpression ?? ''} ${op.ConditionExpression ?? ''}`;
        for (const k of Object.keys((op.ExpressionAttributeValues ?? {}) as object)) {
          expect(text, k).toMatch(new RegExp(`${k}(?![A-Za-z0-9_])`));
        }
        for (const k of Object.keys((op.ExpressionAttributeNames ?? {}) as object)) {
          expect(text, k).toContain(k);
        }
      }
    }
  });
});

describe('outcome, denial and override issuance shapes', () => {
  const table = 'T';

  it('outcome moves an in_progress attempt once and bumps only its own counter', () => {
    for (const [outcome, counter] of [
      ['succeeded', 'successCount'],
      ['failed', 'failureCount'],
    ] as const) {
      const tx = L.buildOutcomeTransaction({ table, attemptId: ATTEMPT, day: DAY, outcome, now: NOW, revision: REV });
      expect(tx.TransactItems[0]!.Update!.ConditionExpression).toContain('#revision = :rev');
      // S10a: a success releases its revision slot; a failure keeps it and is counted.
      expect(tx.TransactItems).toHaveLength(3);
      const revUpdate = tx.TransactItems[2]!.Update!;
      expect(revUpdate.Key).toEqual({ PK: { S: 'PROJECT#open-reception' }, SK: { S: `REV#${REV}` } });
      expect(revUpdate.UpdateExpression).toContain(outcome === 'succeeded' ? '#unsettledCount = #unsettledCount - :one' : '#failureCount = #failureCount + :one');
      expect(revUpdate.UpdateExpression).not.toContain(outcome === 'succeeded' ? 'failureCount' : 'unsettledCount');
      expect(revUpdate.ConditionExpression).toContain('#revision = :rev');
      if (outcome === 'succeeded') expect(revUpdate.ConditionExpression).toContain('#unsettledCount > :zero');
      expect(tx.TransactItems[0]!.Update!.ConditionExpression).toContain('#status = :inProgress');
      const dayUpdate = tx.TransactItems[1]!.Update!.UpdateExpression as string;
      expect(dayUpdate).toContain(`#${counter} = #${counter} + :one`);
      expect(dayUpdate).not.toContain('attemptCount');
    }
    expect(() => L.buildOutcomeTransaction({ table, attemptId: ATTEMPT, day: DAY, outcome: 'denied', now: NOW, revision: REV })).toThrow();
    expect(() => L.buildOutcomeTransaction({ table, attemptId: ATTEMPT, day: DAY, outcome: 'failed', now: NOW, revision: 'short' })).toThrow();
  });

  it('a pre-boundary denial is audit-only and touches no counter', () => {
    const put = L.buildDenialPut({ table, attemptId: ATTEMPT, revision: REV, rule: 'TRUSTED_POLICY_DENY', now: NOW });
    const item = put.Item as Item;
    expect(item.SK).toEqual({ S: `ATTEMPT#${ATTEMPT}` });
    expect(item.status).toEqual({ S: 'denied_before_mutation' });
    expect(put.ConditionExpression).toBe('attribute_not_exists(#PK)');
  });

  const issue = (over: Partial<Parameters<Ledger['buildIssueOverridePut']>[0]> = {}) =>
    L.buildIssueOverridePut({
      table,
      revision: REV,
      rule: 'SPARSE_DAILY_ATTEMPT_CEILING',
      day: DAY,
      expiresAt: epoch(NOW) + 3600,
      reason: 'third proof',
      approver: '20m61',
      now: NOW,
      ...over,
    });

  it('issues a revision-, rule- and day-bound override that is create-only (never replaced)', () => {
    const put = issue();
    expect(put.Item.SK).toEqual({ S: `OVERRIDE#SPARSE_DAILY_ATTEMPT_CEILING#${REV}#${DAY}` });
    expect(put.ConditionExpression).toBe('attribute_not_exists(#PK)');
    // What is issued is exactly what preflight accepts.
    const d = preflight({ dayItem: dayItem(2), overrideItem: put.Item });
    expect(d.mode).toBe('override');
  });

  it.each([
    ['non-overridable rule', { rule: 'SPARSE_LEDGER_UNAVAILABLE' }],
    ['revision-invalid rule', { rule: 'TRUSTED_REVISION_INVALID' }],
    ['short revision', { revision: 'abc' }],
    ['another day', { day: '2026-09-22' }],
    ['past expiry', { expiresAt: epoch(NOW) }],
    ['expiry beyond 24h', { expiresAt: epoch(NOW) + 24 * 3600 + 1 }],
    ['blank reason', { reason: ' ' }],
    ['blank approver', { approver: '' }],
  ])('refuses to issue: %s', (_l, over) => {
    expect(() => issue(over as never)).toThrow();
  });
});

describe('S10a: repeated failures of one revision escalate to a human', () => {
  const revItem = (unsettled: number, failures = unsettled, over: Partial<Item> = {}): Item => ({
    PK: { S: 'PROJECT#open-reception' },
    SK: { S: `REV#${REV}` },
    revision: { S: REV },
    unsettledCount: { N: String(unsettled) },
    failureCount: { N: String(failures) },
    ...over,
  });

  it('one failure may be retried; the second denies with a non-overridable rule', () => {
    expect(preflight({ revisionItem: revItem(1) }).result).toBe('allowed');
    const d = preflight({ revisionItem: revItem(2) });
    expect(d).toMatchObject({ result: 'denied', rule: 'SPARSE_REVISION_REPEATED_FAILURE', retryable: false, revisionUnsettledCount: 2, revisionFailureCount: 2 });
    expect(L.OVERRIDABLE_RULES).not.toContain('SPARSE_REVISION_REPEATED_FAILURE');
    expect(L.MAX_FAILURES_PER_REVISION).toBe(2);
  });

  it('attempts that never recorded an outcome (or are still running) count like failures', () => {
    expect(preflight({ revisionItem: revItem(2, 0) })).toMatchObject({ result: 'denied', rule: 'SPARSE_REVISION_REPEATED_FAILURE', revisionFailureCount: 0 });
    expect(preflight({ revisionItem: revItem(1, 0) }).result).toBe('allowed');
  });

  it('a valid override for the daily ceiling does not lift it, and it is reported before the ceiling (it needs a human)', () => {
    expect(preflight({ dayItem: dayItem(2), overrideItem: overrideItem(), revisionItem: revItem(2) }).rule).toBe('SPARSE_REVISION_REPEATED_FAILURE');
    // Two failures of one revision on one day: escalate, not a routine ceiling denial.
    expect(preflight({ dayItem: dayItem(2), revisionItem: revItem(2) }).rule).toBe('SPARSE_REVISION_REPEATED_FAILURE');
    expect(preflight({ dayItem: dayItem(2), revisionItem: revItem(1) }).rule).toBe('SPARSE_DAILY_ATTEMPT_CEILING');
  });

  it('a malformed or foreign revision counter is corruption, not zero', () => {
    for (const bad of [
      revItem(1, 1, { failureCount: { S: '1' } }),
      revItem(1, 1, { unsettledCount: { S: '1' } }),
      { ...revItem(1), unsettledCount: undefined } as unknown as Item,
      revItem(1, 2),
      revItem(1, 1, { revision: { S: 'f'.repeat(40) } }),
      revItem(1, 1, { SK: { S: 'REV#other' } }),
      { junk: true } as unknown as Item,
    ]) {
      expect(preflight({ revisionItem: bad }).rule, JSON.stringify(bad)).toBe('SPARSE_LEDGER_CORRUPT');
    }
  });

  it('a reservation the ledger refuses reports the rule the ledger now shows (not a bare conflict)', async () => {
    const snapshots = [
      [genesisItem(), dayItem(1), undefined, revItem(1)],
      [genesisItem({ totalAttempts: { N: '41' } }), dayItem(2), undefined, revItem(2, 1)],
    ];
    const writes: unknown[] = [];
    let current: Item[] = [];
    const client = {
      // First read: genesis, day, override, revision. Second read: genesis again and the previous attempt.
      transactGetItems: async (req: { TransactItems: unknown[] }) => {
        if (req.TransactItems.length === 2) return { Responses: [{ Item: current[0] }, { Item: previousAttemptFor(current[0]!) }] };
        current = snapshots.shift()! as Item[];
        return { Responses: current.map((Item) => (Item ? { Item } : {})) };
      },
      transactWriteItems: async (req: unknown) => {
        writes.push(req);
        throw Object.assign(new Error('refused'), { name: 'TransactionCanceledException' });
      },
      putItem: async () => ({}),
    };
    const genesisOk = genesisItem({ lastDay: { S: DAY }, lastDayAttempts: { N: '1' } });
    snapshots[0]![0] = genesisOk;
    // Between preflight and commit the revision's other attempt took the second slot.
    snapshots[1] = [genesisOk, dayItem(1), undefined, revItem(2, 1)];
    const d = await (L as unknown as { reserveAttempt: (i: unknown) => Promise<Decision> }).reserveAttempt({ client, table: 'T', ledgerId: LEDGER_ID, revision: REV, attemptId: ATTEMPT, now: NOW });
    expect(writes).toHaveLength(1);
    expect(d).toMatchObject({ result: 'denied', audited: true });
    expect(d.rule).toBe('SPARSE_REVISION_REPEATED_FAILURE');
    expect(String(d.reason)).toContain('reservation refused by the ledger');
  });
});

// --- D-5 (2026-10-03): access profiles, cooldown, waiver, unsettled previous attempt ----------

describe('D-5 access profiles (Foundation PORTFOLIO_DEFAULTS)', () => {
  it('not restricted keeps 2 / no cooldown / no waiver; restricted is 5 / 1 h / waiver', () => {
    expect(L.ACCESS_PROFILES.not_access_restricted).toEqual({ name: 'not_access_restricted', softCeiling: 2, cooldownSeconds: 0, cooldownWaiver: false });
    expect(L.ACCESS_PROFILES.access_restricted).toEqual({ name: 'access_restricted', softCeiling: 5, cooldownSeconds: 3600, cooldownWaiver: true });
    expect(L.SOFT_ATTEMPT_CEILING).toBe(L.ACCESS_PROFILES.not_access_restricted!.softCeiling);
  });

  it('only a verified restriction selects the restricted profile (absent and unverifiable do not)', () => {
    expect(L.selectAccessProfile({ state: 'verified' }).name).toBe('access_restricted');
    for (const r of [{ state: 'absent' }, { state: 'unverifiable', reason: 'x' }, undefined, null, {}, { state: 'VERIFIED' }, 'verified', { state: ['verified'] }]) {
      expect(L.selectAccessProfile(r).name, JSON.stringify(r)).toBe('not_access_restricted');
    }
  });

  it('the not-restricted overrideable rule name is unchanged (override keys and the issuer IAM depend on it)', () => {
    expect(L.DAILY_CEILING_RULE).toBe('SPARSE_DAILY_ATTEMPT_CEILING');
    expect(L.OVERRIDABLE_RULES).toEqual(['SPARSE_DAILY_ATTEMPT_CEILING']);
    expect(L.RULES.PREVIOUS_ATTEMPT_UNSETTLED).toBe('SPARSE_PREVIOUS_ATTEMPT_UNSETTLED');
    expect(L.RULES.COOLDOWN_ACTIVE).toBe('SPARSE_COOLDOWN_ACTIVE');
  });
});

describe('D-5 genesis previous-attempt pointer: present exactly when an attempt was reserved', () => {
  it.each([
    ['pointer missing after reservations', { lastAttemptId: undefined }],
    ['lastReservedAt missing', { lastReservedAt: undefined }],
    ['lastRevision missing', { lastRevision: undefined }],
    ['lastCooldownWaived missing', { lastCooldownWaived: undefined }],
    ['lastCooldownWaived as string', { lastCooldownWaived: { S: 'false' } }],
    ['lastAttemptId malformed', { lastAttemptId: { S: 'a b' } }],
    ['lastRevision short', { lastRevision: { S: 'abc' } }],
    ['lastReservedAt not an ISO instant', { lastReservedAt: { S: '2026-09-20 10:00' } }],
    ['lastReservedAt not on lastDay', { lastReservedAt: { S: '2026-09-18T03:00:00.000Z' } }],
  ])('denies as corrupt: %s', (_l, over) => {
    const g = genesisItem(over as Partial<Item>);
    for (const [k, v] of Object.entries(over)) if (v === undefined) delete g[k];
    const d = preflight({ genesisItem: g, previousAttemptItem: previousAttemptFor(genesisItem()) });
    expect(d).toMatchObject({ result: 'denied', rule: 'SPARSE_LEDGER_CORRUPT' });
    expect(String(d.reason)).toMatch(/pointer|lastReservedAt/);
  });

  it('a fresh genesis must not carry a pointer', () => {
    const fresh = L.buildGenesisPut({ table: 'T', ledgerId: LEDGER_ID, now: NOW }).Item;
    expect(preflight({ genesisItem: fresh })).toMatchObject({ result: 'allowed', observedTotalAttempts: 0 });
    expect(fresh.lastAttemptId).toBeUndefined();
    const forged = { ...fresh, lastAttemptId: { S: PREV_ATTEMPT } };
    expect(preflight({ genesisItem: forged, previousAttemptItem: undefined })).toMatchObject({ result: 'denied', rule: 'SPARSE_LEDGER_CORRUPT' });
  });
});

describe("D-5 previous attempt's record (read with genesis again)", () => {
  const g = genesisItem();
  it.each([
    ['record missing', undefined],
    ['another attempt id', previousAttemptFor(g, 'succeeded', { attemptId: { S: 'OpenReceptionTrustedDevDeployBroker:other' } })],
    ['key of another attempt', previousAttemptFor(g, 'succeeded', { SK: { S: 'ATTEMPT#OpenReceptionTrustedDevDeployBroker:other' } })],
    ['another revision', previousAttemptFor(g, 'succeeded', { revision: { S: REV } })],
    ['another reservation time', previousAttemptFor(g, 'succeeded', { reservedAt: { S: '2026-09-20T05:00:00.000Z' } })],
    ['waiver differs from genesis', previousAttemptFor(g, 'succeeded', { cooldownWaived: { BOOL: true } })],
    ['no waiver flag', previousAttemptFor(g, 'succeeded', { cooldownWaived: undefined })],
    ['a denial record, not a reservation', previousAttemptFor(g, 'denied_before_mutation')],
    ['no status', previousAttemptFor(g, 'succeeded', { status: undefined })],
  ])('denies as corrupt: %s', (_l, item) => {
    if (item) for (const [k, v] of Object.entries(item)) if (v === undefined) delete item[k];
    expect(preflight({ genesisItem: g, previousAttemptItem: item })).toMatchObject({ result: 'denied', rule: 'SPARSE_LEDGER_CORRUPT' });
  });

  it('a genesis that moved between the two reads is a conflict, not a mix of two states', () => {
    for (const recheck of [
      undefined,
      genesisItem({ totalAttempts: { N: '41' } }),
      genesisItem({ lastAttemptId: { S: 'OpenReceptionTrustedDevDeployBroker:newer' } }),
      genesisItem({ lastCooldownWaived: { BOOL: true } }),
    ]) {
      expect(preflight({ genesisItem: g, genesisRecheckItem: recheck }), JSON.stringify(recheck)).toMatchObject({ result: 'denied', rule: 'SPARSE_LEDGER_CONFLICT' });
    }
  });
});

describe('D-5 unsettled previous attempt blocks the whole project, in both profiles', () => {
  it('denies every next attempt, any revision, any count, even with a valid override; not overridable', () => {
    const g = genesisItem({ lastDay: { S: DAY }, lastDayAttempts: { N: '2' } });
    for (const accessRestriction of [{ state: 'verified' }, { state: 'absent' }, { state: 'unverifiable', reason: 'x' }]) {
      for (const revision of [REV, PREV_REV]) {
        const d = preflight({ revision, genesisItem: g, previousAttemptItem: previousAttemptFor(g, 'in_progress'), dayItem: dayItem(2), overrideItem: overrideItem({}, revision), accessRestriction });
        expect(d).toMatchObject({ result: 'denied', rule: 'SPARSE_PREVIOUS_ATTEMPT_UNSETTLED', retryable: false, previousAttemptId: PREV_ATTEMPT });
      }
    }
    expect(L.OVERRIDABLE_RULES).not.toContain('SPARSE_PREVIOUS_ATTEMPT_UNSETTLED');
    expect(L.OVERRIDABLE_RULES).not.toContain('SPARSE_COOLDOWN_ACTIVE');
  });

  it('is reported before the revision rule and the ceiling (it is the one a human must clear first)', () => {
    const g = genesisItem({ lastDay: { S: DAY }, lastDayAttempts: { N: '2' }, lastRevision: { S: REV } });
    const revisionItem: Item = { PK: { S: 'PROJECT#open-reception' }, SK: { S: `REV#${REV}` }, revision: { S: REV }, unsettledCount: { N: '2' }, failureCount: { N: '1' } };
    expect(preflight({ genesisItem: g, previousAttemptItem: previousAttemptFor(g, 'in_progress'), dayItem: dayItem(2), revisionItem }).rule).toBe('SPARSE_PREVIOUS_ATTEMPT_UNSETTLED');
  });
});

/**
 * Exhaustive sweep (invariants, not per-branch expectations). Two clocks: 00:30 Tokyo (the elapsed
 * windows straddle Tokyo midnight, so the cooldown must not reset there) and 12:00 Tokyo.
 */
describe('D-5 decision invariants over the whole input space', () => {
  const NOWS = [new Date('2026-09-20T15:30:00.000Z'), new Date('2026-09-21T03:00:00.000Z')];
  const ELAPSED = [0, 3599, 3600, 90000];
  const OUTCOMES = ['none', 'succeeded', 'failed', 'in_progress'] as const;
  const RESTRICTIONS = [{ state: 'verified' }, { state: 'absent' }, { state: 'unverifiable', reason: 'no proof' }];

  type Case = {
    now: Date;
    count: number;
    elapsed: number;
    outcome: (typeof OUTCOMES)[number];
    sameRevision: boolean;
    prevWaived: boolean;
    restriction: { state: string };
    withOverride: boolean;
  };

  /** A ledger state the reservation path can produce. `consistent` marks the ones preflight must accept. */
  const build = (c: Case) => {
    const day = L.ledgerDay(c.now);
    const prevAt = new Date(c.now.getTime() - c.elapsed * 1000);
    const prevDay = L.ledgerDay(prevAt);
    const prevRevision = c.sameRevision ? REV : PREV_REV;
    const g: Item =
      c.outcome === 'none'
        ? L.buildGenesisPut({ table: 'T', ledgerId: LEDGER_ID, now: new Date('2026-09-01T00:00:00Z') }).Item
        : genesisItem({
            totalAttempts: { N: String(c.count + 10) },
            lastDay: { S: prevDay },
            lastDayAttempts: { N: String(prevDay === day ? Math.max(c.count, 1) : 1) },
            lastReservedAt: { S: prevAt.toISOString() },
            lastRevision: { S: prevRevision },
            lastCooldownWaived: { BOOL: c.prevWaived },
          });
    const consistent = c.outcome === 'none' ? c.count === 0 : prevDay !== day || c.count >= 1;
    const revisionItem: Item | undefined =
      c.outcome !== 'none' && c.sameRevision && c.outcome !== 'succeeded'
        ? { PK: { S: 'PROJECT#open-reception' }, SK: { S: `REV#${REV}` }, revision: { S: REV }, unsettledCount: { N: '1' }, failureCount: { N: c.outcome === 'failed' ? '1' : '0' } }
        : undefined;
    const ov = c.withOverride ? overrideItem({ SK: { S: `OVERRIDE#SPARSE_DAILY_ATTEMPT_CEILING#${REV}#${day}` }, day: { S: day }, expiresAt: { N: String(epoch(c.now) + 3600) } }) : undefined;
    const d = L.evaluatePreflight({
      revision: REV,
      attemptId: ATTEMPT,
      now: c.now,
      ledgerId: LEDGER_ID,
      genesisItem: g,
      genesisRecheckItem: g,
      previousAttemptItem: c.outcome === 'none' ? undefined : previousAttemptFor(g, c.outcome),
      dayItem: c.count === 0 ? undefined : { ...dayItem(c.count), SK: { S: `DAY#${day}` }, day: { S: day } },
      revisionItem,
      overrideItem: ov,
      accessRestriction: c.restriction,
    });
    return { d, consistent };
  };

  const cases: Case[] = [];
  for (const now of NOWS)
    for (let count = 0; count <= 6; count += 1)
      for (const elapsed of ELAPSED)
        for (const outcome of OUTCOMES)
          for (const sameRevision of [false, true])
            for (const prevWaived of [false, true])
              for (const restriction of RESTRICTIONS)
                for (const withOverride of [false, true]) cases.push({ now, count, elapsed, outcome, sameRevision, prevWaived, restriction, withOverride });

  it('(i) an allow implies: below the profile ceiling (or a consumed-for-this override), nothing unsettled, and a cooldown honoured or validly waived', () => {
    let allows = 0;
    for (const c of cases) {
      const { d } = build(c);
      if (d.result !== 'allowed') continue;
      allows += 1;
      const label = JSON.stringify({ ...c, now: c.now.toISOString() });
      const restricted = c.restriction.state === 'verified';
      const ceiling = restricted ? 5 : 2;
      expect(d.accessProfile, label).toBe(restricted ? 'access_restricted' : 'not_access_restricted');
      expect(c.count < ceiling || (d.mode === 'override' && c.withOverride), label).toBe(true);
      if (d.mode === 'normal') expect(c.count < ceiling, label).toBe(true);
      expect(c.outcome, label).not.toBe('in_progress');
      const inCooldown = c.outcome !== 'none' && c.elapsed < 3600;
      const waiverValid = c.outcome === 'failed' && !c.sameRevision && !c.prevWaived;
      if (restricted) expect(!inCooldown || waiverValid, label).toBe(true);
      expect(d.cooldownWaived, label).toBe(restricted && inCooldown);
      // A waived attempt still consumes budget: it reserves like any other.
      const tx = L.buildReserveTransaction({ table: 'T', decision: d, now: c.now });
      const put = tx.TransactItems.find((e) => e.Put)!.Put!.Item as Item;
      expect(put.cooldownWaived, label).toEqual({ BOOL: restricted && inCooldown });
      expect(put.accessProfile, label).toEqual({ S: restricted ? 'access_restricted' : 'not_access_restricted' });
      expect(put.softCeiling, label).toEqual({ N: String(ceiling) });
      expect(put.attemptNumber, label).toEqual({ N: String(c.count + 1) });
    }
    expect(allows).toBeGreaterThan(100);
  });

  it('(ii) lower bound: not restricted, count < 2, a clean revision and a settled previous attempt allow, whatever the elapsed time', () => {
    let checked = 0;
    for (const c of cases) {
      if (c.restriction.state === 'verified' || c.count >= 2 || c.outcome === 'in_progress') continue;
      const { d, consistent } = build(c);
      if (!consistent) continue;
      checked += 1;
      expect(d, JSON.stringify({ ...c, now: c.now.toISOString() })).toMatchObject({ result: 'allowed', mode: 'normal', cooldownWaived: false });
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('(ii) lower bound: restricted, count < 5, settled, and the cooldown elapsed or validly waived allow', () => {
    let checked = 0;
    for (const c of cases) {
      if (c.restriction.state !== 'verified' || c.count >= 5 || c.outcome === 'in_progress') continue;
      const inCooldown = c.outcome !== 'none' && c.elapsed < 3600;
      const waiverValid = c.outcome === 'failed' && !c.sameRevision && !c.prevWaived;
      if (inCooldown && !waiverValid) continue;
      const { d, consistent } = build(c);
      if (!consistent) continue;
      checked += 1;
      expect(d, JSON.stringify({ ...c, now: c.now.toISOString() })).toMatchObject({ result: 'allowed', mode: 'normal', cooldownWaived: inCooldown });
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('denials carry the rule that caused them: unsettled first, then cooldown, then the ceiling', () => {
    for (const c of cases) {
      const { d, consistent } = build(c);
      if (!consistent) continue;
      const label = JSON.stringify({ ...c, now: c.now.toISOString() });
      const restricted = c.restriction.state === 'verified';
      const inCooldown = c.outcome !== 'none' && c.elapsed < 3600;
      const waiverValid = c.outcome === 'failed' && !c.sameRevision && !c.prevWaived;
      if (c.outcome === 'in_progress') expect(d.rule, label).toBe('SPARSE_PREVIOUS_ATTEMPT_UNSETTLED');
      else if (restricted && inCooldown && !waiverValid) expect(d.rule, label).toBe('SPARSE_COOLDOWN_ACTIVE');
      else if (c.count >= (restricted ? 5 : 2) && !c.withOverride) expect(d.rule, label).toBe('SPARSE_DAILY_ATTEMPT_CEILING');
      else expect(d.result, label).toBe('allowed');
    }
  });

  it('not restricted keeps the pre-D-5 ceiling and override semantics: the elapsed time and the previous outcome (once settled) change nothing', () => {
    for (const c of cases) {
      if (c.restriction.state === 'verified' || c.outcome === 'in_progress' || c.outcome === 'none') continue;
      const { d, consistent } = build(c);
      if (!consistent) continue;
      const before = c.count < 2 ? 'allowed' : c.withOverride ? 'allowed' : 'denied';
      expect(d.result, JSON.stringify({ ...c, now: c.now.toISOString() })).toBe(before);
    }
  });

  it('the cooldown boundary is exactly 3_600_000 ms: 3_599_999 ms denies, 3_600_000 ms allows', () => {
    const at = (ms: number) => {
      const g = genesisItem({ lastDay: { S: DAY }, lastDayAttempts: { N: '1' }, lastReservedAt: { S: new Date(NOW.getTime() - ms).toISOString() } });
      return preflight({ genesisItem: g, previousAttemptItem: previousAttemptFor(g), dayItem: dayItem(1), accessRestriction: { state: 'verified' } });
    };
    expect(at(3_599_999)).toMatchObject({ result: 'denied', rule: 'SPARSE_COOLDOWN_ACTIVE' });
    expect(at(3_600_000)).toMatchObject({ result: 'allowed', cooldownWaived: false });
    expect(at(0)).toMatchObject({ result: 'denied', rule: 'SPARSE_COOLDOWN_ACTIVE' });
  });

  it('the cooldown does not reset at Tokyo midnight', () => {
    const c: Case = { now: NOWS[0]!, count: 0, elapsed: 3599, outcome: 'succeeded', sameRevision: false, prevWaived: false, restriction: { state: 'verified' }, withOverride: false };
    expect(L.ledgerDay(new Date(c.now.getTime() - 3599_000))).not.toBe(L.ledgerDay(c.now));
    expect(build(c).d).toMatchObject({ result: 'denied', rule: 'SPARSE_COOLDOWN_ACTIVE' });
    expect(build({ ...c, elapsed: 3600 }).d).toMatchObject({ result: 'allowed', cooldownWaived: false });
  });

  it('a previous attempt reserved after now is a clock regression under the restricted profile', () => {
    const g = genesisItem({ lastDay: { S: DAY }, lastDayAttempts: { N: '1' }, lastReservedAt: { S: new Date(NOW.getTime() + 1000).toISOString() } });
    expect(preflight({ genesisItem: g, previousAttemptItem: previousAttemptFor(g), dayItem: dayItem(1), accessRestriction: { state: 'verified' } })).toMatchObject({ result: 'denied', rule: 'SPARSE_LEDGER_CORRUPT' });
    // Not restricted: no time is read (only lastDay after today is a regression there).
    for (const accessRestriction of [{ state: 'absent' }, { state: 'unverifiable', reason: 'x' }]) {
      expect(preflight({ genesisItem: g, previousAttemptItem: previousAttemptFor(g), dayItem: dayItem(1), accessRestriction })).toMatchObject({ result: 'allowed', mode: 'normal' });
    }
  });
});

describe('D-5 reserveAttempt: the two reads', () => {
  const reserveAttempt = (client: unknown) =>
    (L as unknown as { reserveAttempt: (i: unknown) => Promise<Decision> }).reserveAttempt({ client, table: 'T', ledgerId: LEDGER_ID, revision: REV, attemptId: ATTEMPT, now: NOW });

  it('reads the previous attempt named on genesis together with genesis again, and denies a genesis that moved in between', async () => {
    const g = genesisItem();
    const moved = genesisItem({ totalAttempts: { N: '41' }, lastAttemptId: { S: 'OpenReceptionTrustedDevDeployBroker:newer' } });
    const reads: string[][] = [];
    const writes: unknown[] = [];
    const client = (second: Item) => ({
      transactGetItems: async (req: { TransactItems: Array<{ Get: { Key: { SK: { S: string } } } }> }) => {
        reads.push(req.TransactItems.map((t) => t.Get.Key.SK.S));
        return req.TransactItems.length === 2 ? { Responses: [{ Item: second }, { Item: previousAttemptFor(g) }] } : { Responses: [{ Item: g }, {}, {}, {}] };
      },
      transactWriteItems: async (req: unknown) => (writes.push(req), {}),
      putItem: async () => ({}),
    });
    expect(await reserveAttempt(client(g))).toMatchObject({ result: 'allowed' });
    expect(reads[1]).toEqual(['META#genesis', `ATTEMPT#${PREV_ATTEMPT}`]);
    expect(writes).toHaveLength(1);
    reads.length = 0;
    expect(await reserveAttempt(client(moved))).toMatchObject({ result: 'denied', rule: 'SPARSE_LEDGER_CONFLICT', audited: true });
    expect(writes).toHaveLength(1);
  });

  it('a fresh genesis needs no second read', async () => {
    const fresh = L.buildGenesisPut({ table: 'T', ledgerId: LEDGER_ID, now: NOW }).Item;
    let reads = 0;
    const d = await reserveAttempt({
      transactGetItems: async () => ((reads += 1), { Responses: [{ Item: fresh }, {}, {}, {}] }),
      transactWriteItems: async () => ({}),
      putItem: async () => ({}),
    });
    expect(d).toMatchObject({ result: 'allowed', observedTotalAttempts: 0 });
    expect(reads).toBe(1);
  });
});

describe('D-5 reservation: pointer compare-and-set and waiver audit', () => {
  const table = 'T';

  it('the first reservation creates the pointer only if absent; later ones compare-and-set the observed attempt', () => {
    const first = L.buildReserveTransaction({ table, decision: preflight({ genesisItem: L.buildGenesisPut({ table, ledgerId: LEDGER_ID, now: NOW }).Item }), now: NOW });
    const g1 = first.TransactItems[0]!.Update!;
    expect(g1.ConditionExpression).toContain('attribute_not_exists(#lastAttemptId)');
    const later = L.buildReserveTransaction({ table, decision: preflight({ dayItem: dayItem(1) }), now: NOW });
    const g2 = later.TransactItems[0]!.Update!;
    expect(g2.ConditionExpression).toContain('#lastAttemptId = :observedLastAttempt');
    expect((g2.ExpressionAttributeValues as Item)[':observedLastAttempt']).toEqual({ S: PREV_ATTEMPT });
    for (const g of [g1, g2]) {
      for (const set of ['#lastAttemptId = :attempt', '#lastReservedAt = :now', '#lastRevision = :rev', '#lastCooldownWaived = :waived']) expect(g.UpdateExpression).toContain(set);
      expect((g.ExpressionAttributeValues as Item)[':attempt']).toEqual({ S: ATTEMPT });
      expect((g.ExpressionAttributeValues as Item)[':now']).toEqual({ S: NOW.toISOString() });
      expect((g.ExpressionAttributeValues as Item)[':rev']).toEqual({ S: REV });
    }
  });

  it('what a reservation writes is exactly what the next preflight reads as the previous attempt', () => {
    const decision = preflight({ dayItem: dayItem(1) });
    const tx = L.buildReserveTransaction({ table, decision, now: NOW });
    const vals = tx.TransactItems[0]!.Update!.ExpressionAttributeValues as Item;
    const g = genesisItem({ totalAttempts: { N: '41' }, lastDay: { S: DAY }, lastDayAttempts: { N: '2' }, lastAttemptId: vals[':attempt']!, lastReservedAt: vals[':now']!, lastRevision: vals[':rev']!, lastCooldownWaived: vals[':waived']! });
    const record = tx.TransactItems.find((e) => e.Put)!.Put!.Item as Item;
    const later = new Date(NOW.getTime() + 60_000);
    expect(L.evaluatePreflight({ revision: REV_B, attemptId: `${ATTEMPT}-2`, now: later, ledgerId: LEDGER_ID, genesisItem: g, genesisRecheckItem: g, previousAttemptItem: record, dayItem: dayItem(2) })).toMatchObject({ result: 'denied', rule: 'SPARSE_PREVIOUS_ATTEMPT_UNSETTLED' });
    expect(L.evaluatePreflight({ revision: REV_B, attemptId: `${ATTEMPT}-2`, now: later, ledgerId: LEDGER_ID, genesisItem: g, genesisRecheckItem: g, previousAttemptItem: { ...record, status: { S: 'failed' } }, dayItem: dayItem(2), accessRestriction: { state: 'verified' } })).toMatchObject({ result: 'allowed', cooldownWaived: true });
  });

  it('refuses a decision whose profile, ceiling or waiver flag was altered', () => {
    const normal = preflight({ dayItem: dayItem(1) });
    for (const bad of [
      { accessProfile: 'unknown' },
      { accessProfile: 'access_restricted' },
      { softCeiling: 5 },
      { cooldownWaived: true },
      { cooldownWaived: undefined },
      { observedLastAttemptId: undefined },
    ]) {
      expect(() => L.buildReserveTransaction({ table, decision: { ...normal, ...bad } as Decision, now: NOW }), JSON.stringify(bad)).toThrow();
    }
    const restricted = preflight({ dayItem: dayItem(4), accessRestriction: { state: 'verified' } });
    expect(restricted).toMatchObject({ result: 'allowed', mode: 'normal', softCeiling: 5 });
    expect(() => L.buildReserveTransaction({ table, decision: restricted, now: NOW })).not.toThrow();
    expect(() => L.buildReserveTransaction({ table, decision: { ...restricted, observedAttemptCount: 5 }, now: NOW })).toThrow();
  });
});

/**
 * The issuer role's `dynamodb:Attributes` allowlist (runbook step 2) must stay valid: genesis and
 * the close-as-failed path write only listed attributes, and what only the broker writes (the D-5
 * pointer and waiver) is not on the issuer's list.
 */
describe('issuer role attribute allowlist (runbook step 2) stays valid', () => {
  const runbook = readFileSync(path.resolve(__dirname, '../../docs/runbook-sparse-ledger-activation.md'), 'utf8');
  const block = [...runbook.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!).find((b) => b.includes('"Sid": "CloseAttemptAsFailed"'));
  const policy = JSON.parse(block!) as {
    Statement: Array<{ Sid: string; Condition: Record<string, Record<string, string[]>> }>;
  };
  const allowed = (sid: string) => new Set(policy.Statement.find((s) => s.Sid === sid)!.Condition['ForAllValues:StringEquals']!['dynamodb:Attributes']);
  const namesOf = (op: Record<string, unknown>) => {
    const text = `${(op.UpdateExpression as string) ?? ''} ${(op.ConditionExpression as string) ?? ''}`;
    return new Set([...Object.keys((op.Item as object) ?? {}), ...[...text.matchAll(/#([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]!), 'PK', 'SK']);
  };

  it('genesis and override puts use only GenesisAndOverride attributes', () => {
    const list = allowed('GenesisAndOverride');
    const ops = [
      L.buildGenesisPut({ table: 'T', ledgerId: LEDGER_ID, now: NOW }) as unknown as Record<string, unknown>,
      L.buildIssueOverridePut({ table: 'T', revision: REV, rule: 'SPARSE_DAILY_ATTEMPT_CEILING', day: DAY, expiresAt: epoch(NOW) + 60, reason: 'r', approver: 'a', now: NOW }) as unknown as Record<string, unknown>,
    ];
    for (const op of ops) for (const n of namesOf(op)) expect(list.has(n), n).toBe(true);
  });

  it('closing an attempt as failed uses only CloseAttemptAsFailed attributes', () => {
    const list = allowed('CloseAttemptAsFailed');
    for (const e of L.buildOutcomeTransaction({ table: 'T', attemptId: ATTEMPT, day: DAY, outcome: 'failed', now: NOW, revision: REV }).TransactItems) {
      for (const n of namesOf(Object.values(e)[0]!)) expect(list.has(n), n).toBe(true);
    }
  });

  it('the D-5 pointer, waiver and profile are broker-only (not on any issuer list)', () => {
    const all = new Set([...allowed('GenesisAndOverride'), ...allowed('CloseAttemptAsFailed')]);
    for (const n of ['lastAttemptId', 'lastReservedAt', 'lastRevision', 'lastCooldownWaived', 'cooldownWaived', 'accessProfile', 'softCeiling', 'lastDay', 'lastDayAttempts']) expect(all.has(n), n).toBe(false);
  });
});
