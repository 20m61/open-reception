import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

type DynamoItem = Record<string, { S?: string; N?: string }>;

type LedgerModule = {
  SOFT_SUCCESS_CEILING: number;
  tokyoDay(now?: Date): string;
  evaluatePreflight(input: {
    revision: string;
    now?: Date;
    dayItem?: DynamoItem;
    overrideItem?: DynamoItem;
  }): Record<string, unknown>;
};

let ledger: LedgerModule;
const REVISION = 'a'.repeat(40);

beforeAll(async () => {
  const url = pathToFileURL(path.resolve(__dirname, '../broker/sparse-ledger.mjs')).href;
  ledger = (await import(url)) as LedgerModule;
});

const countItem = (count: number): DynamoItem => ({
  successCount: { N: String(count) },
});

const overrideItem = ({
  revision = REVISION,
  day = '2026-09-21',
  expiresAt = 1_795_000_000,
  reason = 'explicit third dev integration proof',
  approver = '20m61',
}: {
  revision?: string;
  day?: string;
  expiresAt?: number;
  reason?: string;
  approver?: string;
} = {}): DynamoItem => ({
  revision: { S: revision },
  day: { S: day },
  expiresAt: { N: String(expiresAt) },
  reason: { S: reason },
  approver: { S: approver },
});

describe('sparse successful-deploy ledger policy (#1153)', () => {
  const now = new Date('2026-09-21T03:00:00.000Z'); // 12:00 JST

  it('uses Asia/Tokyo for the deploy day boundary', () => {
    expect(ledger.tokyoDay(new Date('2026-09-20T14:59:59.000Z'))).toBe('2026-09-20');
    expect(ledger.tokyoDay(new Date('2026-09-20T15:00:00.000Z'))).toBe('2026-09-21');
  });

  it('allows the first and second successful deploy without a human override', () => {
    for (const count of [0, 1]) {
      const result = ledger.evaluatePreflight({
        revision: REVISION,
        now,
        dayItem: countItem(count),
        overrideItem: {},
      });
      expect(result.result).toBe('allowed');
      expect(result.mode).toBe('normal');
    }
    expect(ledger.SOFT_SUCCESS_CEILING).toBe(2);
  });

  it('requires an override once two successes already exist', () => {
    const result = ledger.evaluatePreflight({
      revision: REVISION,
      now,
      dayItem: countItem(2),
      overrideItem: {},
    });
    expect(result.result).toBe('denied');
    expect(result.rule).toBe('SPARSE_DEPLOY_OVERRIDE_REQUIRED');
    expect(result.retryable).toBe(false);
  });

  it('allows an exact, live, reasoned, revision-bound override', () => {
    const result = ledger.evaluatePreflight({
      revision: REVISION,
      now,
      dayItem: countItem(2),
      overrideItem: overrideItem(),
    });
    expect(result.result).toBe('allowed');
    expect(result.mode).toBe('override');
    expect(result.day).toBe('2026-09-21');
  });

  it.each([
    ['different revision', overrideItem({ revision: 'b'.repeat(40) })],
    ['different Tokyo day', overrideItem({ day: '2026-09-20' })],
    ['expired', overrideItem({ expiresAt: Math.floor(now.getTime() / 1000) })],
    ['missing reason', overrideItem({ reason: '   ' })],
    ['missing approver', overrideItem({ approver: '   ' })],
  ])('denies %s override', (_label, override) => {
    const result = ledger.evaluatePreflight({
      revision: REVISION,
      now,
      dayItem: countItem(2),
      overrideItem: override,
    });
    expect(result.result).toBe('denied');
    expect(result.rule).toBe('SPARSE_DEPLOY_OVERRIDE_REQUIRED');
  });

  it('fails closed on a corrupt success count', () => {
    const result = ledger.evaluatePreflight({
      revision: REVISION,
      now,
      dayItem: { successCount: { N: '-1' } },
      overrideItem: {},
    });
    expect(result.result).toBe('denied');
    expect(result.rule).toBe('SPARSE_LEDGER_CORRUPT');
  });

  it('fails closed when trusted revision is not a full commit id', () => {
    const result = ledger.evaluatePreflight({
      revision: 'main',
      now,
      dayItem: countItem(0),
      overrideItem: {},
    });
    expect(result.result).toBe('denied');
    expect(result.rule).toBe('TRUSTED_REVISION_INVALID');
  });
});
