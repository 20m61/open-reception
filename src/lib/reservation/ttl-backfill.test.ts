import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { FakeDoc } from '@/lib/data/fake-dynamo';
import { reservationTtlSeconds } from '@/domain/reservation/retention';
import type { VisitReservation } from '@/domain/reservation/types';
import { DataBackedReservationRepository, RESERVATION_COLLECTION } from './data-backed-repository';
import { DynamoBackend } from '@/lib/data/dynamodb';
import {
  runReservationTtlBackfill,
  TtlBackfillAbortedError,
  type TtlBackfillReport,
} from './ttl-backfill';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const PK = `col#${RESERVATION_COLLECTION}`;
const TABLE = 'T';

/** #1244 より前の形（`ttl` を持たない）で直接置く。アプリの書き込み経路は通さない。 */
function legacy(fake: FakeDoc, id: string, over: Record<string, unknown> = {}): void {
  fake.store.set(`${PK}\u0000${id}`, {
    PK,
    SK: id,
    id,
    tenantId: 't',
    siteId: 's',
    visitorName: 'TEST-来訪者',
    visitAt: iso(NOW + DAY),
    expiresAt: iso(NOW + 2 * DAY),
    retentionDays: 30,
    ...over,
  });
}

function stored(fake: FakeDoc, id: string): Record<string, unknown> | undefined {
  return fake.store.get(`${PK}\u0000${id}`);
}

const doc = (fake: FakeDoc) => fake as unknown as DynamoDBDocumentClient;

/** apply の結果へ絞る（dry-run が返ったらその場で落とす）。 */
function applied(report: TtlBackfillReport): Extract<TtlBackfillReport, { mode: 'apply' }> {
  if (report.mode !== 'apply') throw new Error(`expected apply, got ${report.mode}`);
  return report;
}

describe('runReservationTtlBackfill (#1022 backfill)', () => {
  it('dry-run は 1 件も書かない（Query 以外のコマンドを送らない）', async () => {
    const fake = new FakeDoc();
    legacy(fake, 'a');
    legacy(fake, 'bad', { retentionDays: 0 });
    const report = await runReservationTtlBackfill({ doc: doc(fake), table: TABLE, nowMs: NOW });
    expect(report.mode).toBe('dry-run');
    expect(report.plan.summary).toMatchObject({ scanned: 2, toSet: 1, uncomputable: 1 });
    expect(report.plan.uncomputableIds).toEqual(['bad']);
    expect(fake.calls.every((c) => c.name === 'QueryCommand')).toBe(true);
    expect(stored(fake, 'a')?.ttl).toBeUndefined();
  });

  it('全ページを走査する（アプリの list の 1000 件上限で止めない）', async () => {
    const fake = new FakeDoc();
    fake.pageSize = 2;
    for (let i = 0; i < 5; i += 1) legacy(fake, `r${i}`);
    legacy(fake, 'bad', { visitAt: 'x' });
    const report = await runReservationTtlBackfill({ doc: doc(fake), table: TABLE, nowMs: NOW });
    expect(report.plan.summary.scanned).toBe(6);
    expect(report.plan.uncomputableIds).toEqual(['bad']);
    // 走査は予約のパーティションだけ（他コレクションへ触れない）。
    expect(fake.queries.every((q) => (q.ExpressionAttributeValues as never)[':pk'] === PK)).toBe(true);
  });

  it('予約以外のパーティションは対象にしない', async () => {
    const fake = new FakeDoc();
    legacy(fake, 'a');
    fake.store.set('col#kiosk\u0000k', { PK: 'col#kiosk', SK: 'k', id: 'k' });
    const report = await runReservationTtlBackfill({ doc: doc(fake), table: TABLE, nowMs: NOW });
    expect(report.plan.summary.scanned).toBe(1);
  });

  it('apply は計算した ttl だけを付け、ほかの属性は変えない', async () => {
    const fake = new FakeDoc();
    legacy(fake, 'a');
    legacy(fake, 'bad', { retentionDays: '30' });
    const before = { ...stored(fake, 'a') };
    const report = await runReservationTtlBackfill({
      doc: doc(fake),
      table: TABLE,
      nowMs: NOW,
      apply: { expectedToSet: 1 },
    });
    expect(report.mode).toBe('apply');
    expect(applied(report).applied).toEqual({ updated: 1, skippedChanged: 0 });
    const expected = reservationTtlSeconds(before as unknown as VisitReservation);
    expect(stored(fake, 'a')).toEqual({ ...before, ttl: expected });
    // 計算できないレコードには何も付けない（報告だけ）。
    expect(stored(fake, 'bad')?.ttl).toBeUndefined();
  });

  it('apply 後、アプリの読み取りは変わらず、書き戻しても同じ ttl になる（アプリと同じ関数）', async () => {
    const fake = new FakeDoc();
    legacy(fake, 'a');
    await runReservationTtlBackfill({ doc: doc(fake), table: TABLE, nowMs: NOW, apply: { expectedToSet: 1 } });
    const backfilled = stored(fake, 'a')?.ttl;
    const backend = new DynamoBackend({ doc: doc(fake), table: TABLE });
    const repo = new DataBackedReservationRepository({ backend: () => backend, now: () => new Date(NOW) });
    const r = await repo.get('t' as never, 's' as never, 'a' as never);
    expect(r).toBeDefined();
    if (!r) return;
    await repo.put(r);
    expect(stored(fake, 'a')?.ttl).toBe(backfilled);
  });

  it('apply は dry-run で見た件数と違えば 1 件も書かずに止まる', async () => {
    const fake = new FakeDoc();
    legacy(fake, 'a');
    legacy(fake, 'b');
    await expect(
      runReservationTtlBackfill({ doc: doc(fake), table: TABLE, nowMs: NOW, apply: { expectedToSet: 1 } }),
    ).rejects.toBeInstanceOf(TtlBackfillAbortedError);
    expect(fake.calls.some((c) => c.name === 'UpdateCommand')).toBe(false);
  });

  it('走査後に ttl が付いた・期限の属性が変わったレコードは上書きせず数える', async () => {
    const fake = new FakeDoc();
    legacy(fake, 'got-ttl');
    legacy(fake, 'edited');
    legacy(fake, 'no-days', { retentionDays: undefined });
    legacy(fake, 'days-added', { retentionDays: undefined });
    legacy(fake, 'ok');
    // 走査（Query）の後、最初の書き込みの直前に別の書き手が割り込んだ状態を作る。
    const send = fake.send.bind(fake);
    let raced = false;
    fake.send = async (command: unknown) => {
      if (!raced && (command as { constructor: { name: string } }).constructor.name === 'UpdateCommand') {
        raced = true;
        stored(fake, 'got-ttl')!.ttl = 42;
        stored(fake, 'edited')!.visitAt = iso(NOW + 5 * DAY);
        stored(fake, 'days-added')!.retentionDays = 7;
      }
      return send(command);
    };
    const report = await runReservationTtlBackfill({
      doc: doc(fake),
      table: TABLE,
      nowMs: NOW,
      apply: { expectedToSet: 5 },
    });
    expect(applied(report).applied).toEqual({ updated: 2, skippedChanged: 3 });
    expect(applied(report).skippedChangedIds).toEqual(['days-added', 'edited', 'got-ttl']);
    expect(stored(fake, 'got-ttl')?.ttl).toBe(42);
    expect(stored(fake, 'edited')?.ttl).toBeUndefined();
    expect(stored(fake, 'days-added')?.ttl).toBeUndefined();
    expect(stored(fake, 'no-days')?.ttl).toBeTypeOf('number');
    expect(stored(fake, 'ok')?.ttl).toBeTypeOf('number');
  });

  it('走査後に消えたレコードを作り直さない', async () => {
    const fake = new FakeDoc();
    legacy(fake, 'gone');
    const send = fake.send.bind(fake);
    fake.send = async (command: unknown) => {
      if ((command as { constructor: { name: string } }).constructor.name === 'UpdateCommand') {
        fake.store.delete(`${PK}\u0000gone`);
      }
      return send(command);
    };
    const report = await runReservationTtlBackfill({
      doc: doc(fake),
      table: TABLE,
      nowMs: NOW,
      apply: { expectedToSet: 1 },
    });
    expect(applied(report).applied).toEqual({ updated: 0, skippedChanged: 1 });
    expect(stored(fake, 'gone')).toBeUndefined();
  });

  it('条件失敗以外の書き込みエラーは握り潰さず、それまでの件数を添えて投げる', async () => {
    const fake = new FakeDoc();
    legacy(fake, 'a');
    legacy(fake, 'b');
    const send = fake.send.bind(fake);
    fake.send = async (command: unknown) => {
      if ((command as { constructor: { name: string } }).constructor.name === 'UpdateCommand') {
        const key = (command as { input: { Key: { SK: string } } }).input.Key.SK;
        if (key === 'b') throw Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' });
      }
      return send(command);
    };
    await expect(
      runReservationTtlBackfill({ doc: doc(fake), table: TABLE, nowMs: NOW, apply: { expectedToSet: 2 } }),
    ).rejects.toThrow(/updated 1,.*reservation b:.*Re-running is safe/);
  });
});
