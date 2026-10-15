import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { FakeDoc } from '@/lib/data/fake-dynamo';
import { RESERVATION_COLLECTION } from './data-backed-repository';
import {
  formatTtlBackfillReport,
  parseTtlBackfillArgs,
  runTtlBackfillCli,
  ttlBackfillExitCode,
  TtlBackfillUsageError,
} from './ttl-backfill-cli';
import { TtlBackfillAbortedError, type TtlBackfillReport } from './ttl-backfill';

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

describe('ttlBackfillExitCode', () => {
  // runbook の表（0 = 完了 / 1 = 実行時エラー / 2 = 引数の誤り / 3 = 件数が変わった・未書き込み）と同じ対応。
  it('失敗の種類ごとに終了コードを返す', () => {
    expect(ttlBackfillExitCode(undefined)).toBe(0);
    expect(ttlBackfillExitCode(new TtlBackfillUsageError('x'))).toBe(2);
    expect(ttlBackfillExitCode(new TtlBackfillAbortedError(1, 2))).toBe(3);
    expect(ttlBackfillExitCode(new Error('throttled'))).toBe(1);
    expect(ttlBackfillExitCode('not an error')).toBe(1);
  });

  it('名前だけ似せたエラーを 2 / 3 に数えない（0 や 3 を誤って返さない）', () => {
    expect(ttlBackfillExitCode(Object.assign(new Error('x'), { name: 'TtlBackfillAbortedError' }))).toBe(1);
    expect(ttlBackfillExitCode(Object.assign(new Error('x'), { name: 'TtlBackfillUsageError' }))).toBe(1);
    expect(ttlBackfillExitCode(null)).toBe(1);
  });
});

describe('runTtlBackfillCli（終了コードの配線）', () => {
  const PK = `col#${RESERVATION_COLLECTION}`;
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.now();

  function setup() {
    const fake = new FakeDoc();
    fake.store.set(`${PK}\u0000a`, {
      PK,
      SK: 'a',
      visitAt: new Date(NOW + DAY).toISOString(),
      expiresAt: new Date(NOW + 2 * DAY).toISOString(),
      retentionDays: 30,
    });
    const out: string[] = [];
    const err: string[] = [];
    let connected = 0;
    const deps = {
      connect: () => {
        connected += 1;
        return { doc: fake as unknown as DynamoDBDocumentClient, target: 'runtime=test' };
      },
      nowMs: () => NOW,
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
    };
    return { fake, out, err, deps, connected: () => connected };
  }

  it('dry-run は 0', async () => {
    const t = setup();
    expect(await runTtlBackfillCli(['--table', 'T'], t.deps)).toBe(0);
    expect(t.out.join('\n')).toContain('toSet: 1');
  });

  it('引数の誤りは 2 で、接続もしない', async () => {
    const t = setup();
    expect(await runTtlBackfillCli(['--table', 'T', '--apply'], t.deps)).toBe(2);
    expect(t.connected()).toBe(0);
    expect(t.err.join('\n')).toContain('--expect-to-set');
  });

  it('dry-run 後に件数が変わったら 3 で、1 件も書かない', async () => {
    const t = setup();
    expect(await runTtlBackfillCli(['--table', 'T', '--apply', '--expect-to-set', '2'], t.deps)).toBe(3);
    expect(t.fake.calls.some((c) => c.name === 'UpdateCommand')).toBe(false);
  });

  it('実行時エラーは 1', async () => {
    const t = setup();
    t.fake.send = async () => {
      throw new Error('network down');
    };
    expect(await runTtlBackfillCli(['--table', 'T'], t.deps)).toBe(1);
    expect(t.err.join('\n')).toContain('network down');
  });

  it('接続の解決で投げても 1 を返す（未処理の reject にしない）', async () => {
    const t = setup();
    const deps = {
      ...t.deps,
      connect: () => {
        throw new Error('real credentials in a local lane');
      },
    };
    expect(await runTtlBackfillCli(['--table', 'T'], deps)).toBe(1);
  });

  it('apply が通れば 0', async () => {
    const t = setup();
    expect(await runTtlBackfillCli(['--table', 'T', '--apply', '--expect-to-set', '1'], t.deps)).toBe(0);
    expect(t.out.join('\n')).toContain('updated: 1');
  });
});
