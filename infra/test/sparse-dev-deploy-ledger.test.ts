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

type Attr = { S?: string; N?: string };
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
const genesisItem = (over: Partial<Item> = {}): Item => ({
  PK: { S: 'PROJECT#open-reception' },
  SK: { S: 'META#genesis' },
  ledgerId: { S: LEDGER_ID },
  timezone: { S: 'Asia/Tokyo' },
  createdAt: { S: '2026-09-01T00:00:00.000Z' },
  totalAttempts: { N: '40' },
  lastDay: { S: '2026-09-20' },
  lastDayAttempts: { N: '1' },
  ...over,
});

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

const preflight = (over: Partial<Parameters<Ledger['evaluatePreflight']>[0]> = {}) =>
  L.evaluatePreflight({ revision: REV, attemptId: ATTEMPT, now: NOW, ledgerId: LEDGER_ID, genesisItem: genesisItem(), ...over });

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
    expect(tx.TransactItems).toHaveLength(3);
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
    expect(tx.TransactItems).toHaveLength(4);
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
      ...L.buildOutcomeTransaction({ table, attemptId: ATTEMPT, day: DAY, outcome: 'succeeded', now: NOW }).TransactItems,
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
      L.buildOutcomeTransaction({ table, attemptId: ATTEMPT, day: DAY, outcome: 'failed', now: NOW }),
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
      const tx = L.buildOutcomeTransaction({ table, attemptId: ATTEMPT, day: DAY, outcome, now: NOW });
      expect(tx.TransactItems[0]!.Update!.ConditionExpression).toContain('#status = :inProgress');
      const dayUpdate = tx.TransactItems[1]!.Update!.UpdateExpression as string;
      expect(dayUpdate).toContain(`#${counter} = #${counter} + :one`);
      expect(dayUpdate).not.toContain('attemptCount');
    }
    expect(() => L.buildOutcomeTransaction({ table, attemptId: ATTEMPT, day: DAY, outcome: 'denied', now: NOW })).toThrow();
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
