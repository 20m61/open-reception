import { describe, expect, it } from 'vitest';
import {
  formatTtlBackfillReport,
  parseTtlBackfillArgs,
  TtlBackfillUsageError,
} from './ttl-backfill-cli';
import type { TtlBackfillReport } from './ttl-backfill';

describe('parseTtlBackfillArgs', () => {
  it('既定は dry-run', () => {
    expect(parseTtlBackfillArgs(['--table', 'T'])).toEqual({ table: 'T', json: false });
  });

  it('apply は dry-run で見た件数を必須にする', () => {
    expect(parseTtlBackfillArgs(['--table', 'T', '--apply', '--expect-to-set', '12'])).toEqual({
      table: 'T',
      apply: { expectedToSet: 12 },
      json: false,
    });
    for (const bad of [
      ['--table', 'T', '--apply'],
      ['--table', 'T', '--apply', '--expect-to-set', '-1'],
      ['--table', 'T', '--apply', '--expect-to-set', '1.5'],
      ['--table', 'T', '--apply', '--expect-to-set', ''],
    ]) {
      expect(() => parseTtlBackfillArgs(bad)).toThrow(TtlBackfillUsageError);
    }
  });

  it('0 件の apply も明示すれば受け付ける', () => {
    expect(parseTtlBackfillArgs(['--table', 'T', '--apply', '--expect-to-set', '0']).apply).toEqual({
      expectedToSet: 0,
    });
  });

  it('table 無し・未知の引数・apply 無しの --expect-to-set は誤り', () => {
    expect(() => parseTtlBackfillArgs([])).toThrow(/--table is required/);
    expect(() => parseTtlBackfillArgs(['--table'])).toThrow(/--table is required/);
    expect(() => parseTtlBackfillArgs(['--table', 'T', '--dry'])).toThrow(/unknown argument/);
    expect(() => parseTtlBackfillArgs(['--table', 'T', '--expect-to-set', '1'])).toThrow(
      /only valid with --apply/,
    );
  });
});

describe('formatTtlBackfillReport', () => {
  const plan = (uncomputableIds: string[], mismatchIds: string[]): TtlBackfillReport['plan'] => ({
    actions: [{ id: 'a', ttl: 1 }],
    uncomputableIds,
    mismatchIds,
    summary: {
      scanned: 1 + uncomputableIds.length + mismatchIds.length,
      toSet: 1,
      toSetAlreadyExpired: 0,
      alreadySet: 0,
      mismatch: mismatchIds.length,
      uncomputable: uncomputableIds.length,
    },
  });

  it('計算できない件数は 0 件でも行を出し、id を 1 件ずつ並べて要判断を示す', () => {
    const clean = formatTtlBackfillReport({ mode: 'dry-run', plan: plan([], []) });
    expect(clean).toContain('uncomputable: 0');
    expect(clean).not.toContain('ACTION NEEDED');

    // どちらか片方だけでも要判断を出す。
    expect(formatTtlBackfillReport({ mode: 'dry-run', plan: plan(['u1'], []) })).toContain('ACTION NEEDED');
    expect(formatTtlBackfillReport({ mode: 'dry-run', plan: plan([], ['m1']) })).toContain('ACTION NEEDED');

    const dirty = formatTtlBackfillReport({ mode: 'dry-run', plan: plan(['u1', 'u2'], ['m1']) });
    expect(dirty).toContain('uncomputable: 2');
    expect(dirty).toContain('uncomputable id: u1');
    expect(dirty).toContain('uncomputable id: u2');
    expect(dirty).toContain('mismatch id: m1');
    expect(dirty).toContain('ACTION NEEDED');
  });

  it('apply は書いた件数と、走査後に変わって飛ばした id を出す', () => {
    const text = formatTtlBackfillReport({
      mode: 'apply',
      plan: plan([], []),
      applied: { updated: 0, skippedChanged: 1 },
      skippedChangedIds: ['a'],
    });
    expect(text).toContain('mode: apply');
    expect(text).toContain('updated: 0');
    expect(text).toContain('skippedChanged id: a');
  });
});
