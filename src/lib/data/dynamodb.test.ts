/**
 * DynamoBackend の単体テスト。
 * 実 DynamoDB の代わりに in-memory の fake DocumentClient を注入し、
 * キー生成・marshalling・ソート順・GSI findBy・TTL 付与を検証する。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { DEFAULT_COLLECTION_LIST_LIMIT } from './backend';
import { DynamoBackend } from './dynamodb';

import { FakeDoc, makeDynamoBackend as makeBackend } from './fake-dynamo';

describe('DynamoBackend collection', () => {
  let backend: DynamoBackend;
  let fake: FakeDoc;
  beforeEach(() => {
    ({ backend, fake } = makeBackend());
  });

  it('put/get/list/remove round-trips and strips internal keys', async () => {
    const col = backend.collection<{ id: string; name: string }>('department');
    await col.put({ id: 'd1', name: 'A' });
    await col.put({ id: 'd2', name: 'B' });

    const got = await col.get('d1');
    expect(got).toEqual({ id: 'd1', name: 'A' });
    expect(got).not.toHaveProperty('PK');
    expect(got).not.toHaveProperty('SK');

    const list = await col.list();
    expect(list).toHaveLength(2);
    expect(list.map((d) => d.id).sort()).toEqual(['d1', 'd2']);

    await col.remove('d1');
    expect(await col.get('d1')).toBeUndefined();
  });

  it('writes correct PK/SK for collection items', async () => {
    const col = backend.collection<{ id: string }>('staff');
    await col.put({ id: 's1' });
    const raw = [...fake.store.values()][0]!;
    expect(raw.PK).toBe('col#staff');
    expect(raw.SK).toBe('s1');
  });

  it('updateIf は条件一致時のみ部分更新し、不一致/不在は false（CAS, #239）', async () => {
    const col = backend.collection<{ id: string; token?: string; other: string }>('device');
    await col.put({ id: 'x', token: 'jti-1', other: 'keep' });

    // 一致 → token を消去（REMOVE）。他フィールドは保持。
    expect(await col.updateIf('x', { token: undefined }, { token: 'jti-1' })).toBe(true);
    const after = await col.get('x');
    expect(after?.token).toBeUndefined();
    expect(after?.other).toBe('keep'); // lost-update しない（全置換でない）。

    // 旧 token はもう一致しない（消費済）→ false、変更されない。
    expect(await col.updateIf('x', { other: 'changed' }, { token: 'jti-1' })).toBe(false);
    expect((await col.get('x'))?.other).toBe('keep');

    // 不在 id → false。
    expect(await col.updateIf('ghost', { other: 'z' }, { token: 'jti-1' })).toBe(false);
  });

  it('updateIf は不在 id を upsert しない（expected 空でも false, #239）', async () => {
    const col = backend.collection<{ id: string; other: string }>('device');
    // expected 空（無条件）でも、不在 id は作成せず false（attribute_exists ガード）。
    expect(await col.updateIf('ghost', { other: 'z' }, {})).toBe(false);
    expect(await col.get('ghost')).toBeUndefined();
  });

  it('updateIf は changes 空のとき純粋な CAS 表明（書込なし, #239）', async () => {
    const col = backend.collection<{ id: string; token?: string }>('device');
    await col.put({ id: 'x', token: 'jti-1' });
    // 一致 → true（書込なし）。
    expect(await col.updateIf('x', {}, { token: 'jti-1' })).toBe(true);
    // 不一致 → false。
    expect(await col.updateIf('x', {}, { token: 'jti-2' })).toBe(false);
    // 不在 id → false。
    expect(await col.updateIf('ghost', {}, { token: 'jti-1' })).toBe(false);
  });

  it('list() は既定上限を Query の Limit パラメータへ反映する（#274）', async () => {
    const col = backend.collection<{ id: string }>('staff');
    await col.put({ id: 's1' });
    fake.queries = [];
    await col.list();
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0]!.Limit).toBe(DEFAULT_COLLECTION_LIST_LIMIT);
  });

  it('list({ limit }) は明示上限を Limit へ反映し、結果を切り詰める（#274）', async () => {
    const col = backend.collection<{ id: string; n: number }>('staff');
    for (let i = 0; i < 5; i += 1) await col.put({ id: `s${i}`, n: i });
    fake.queries = [];
    const list = await col.list({ limit: 2 });
    expect(list).toHaveLength(2);
    expect(fake.queries[0]!.Limit).toBe(2);
  });

  it('list() は複数ページにまたがっても上限で打ち切る（残ページを読み続けない, #274）', async () => {
    const col = backend.collection<{ id: string; n: number }>('staff');
    for (let i = 0; i < 5; i += 1) await col.put({ id: `s${i}`, n: i });
    fake.pageSize = 2; // 1MB 制限の代替: 1 ページ最大 2 件。
    fake.queries = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const list = await col.list({ limit: 3 });
    expect(list).toHaveLength(3);
    // 2 件 + 1 件の 2 ページで打ち切る。2 ページ目の Limit は残数（1）。
    expect(fake.queries).toHaveLength(2);
    expect(fake.queries[1]!.Limit).toBe(1);
    expect(fake.queries[1]!.ExclusiveStartKey).toBeDefined();
    // 切り詰めが起きたことを warn で明示する。
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('staff'));
    warn.mockRestore();
  });

  it('list() は上限未満なら全件返す（挙動不変, #274）', async () => {
    const col = backend.collection<{ id: string; n: number }>('staff');
    for (let i = 0; i < 3; i += 1) await col.put({ id: `s${i}`, n: i });
    expect(await col.list()).toHaveLength(3);
    expect(await col.list({ limit: 10 })).toHaveLength(3);
  });

  it('adds a ttl attribute when ttlSeconds is set', async () => {
    const col = backend.collection<{ id: string }>('reception', { ttlSeconds: 3600 });
    const before = Math.floor(Date.now() / 1000);
    await col.put({ id: 'r1' });
    const raw = [...fake.store.values()][0]!;
    expect(typeof raw.ttl).toBe('number');
    expect(raw.ttl as number).toBeGreaterThanOrEqual(before + 3600);
  });

  it('omits ttl when ttlSeconds is not set', async () => {
    const col = backend.collection<{ id: string }>('staff');
    await col.put({ id: 's1' });
    const raw = [...fake.store.values()][0]!;
    expect(raw).not.toHaveProperty('ttl');
  });
});

describe('DynamoBackend collection putIfAbsent() の条件付き作成 (#367)', () => {
  type Item = { id: string; label: string };
  let backend: DynamoBackend;
  let fake: FakeDoc;
  beforeEach(() => {
    ({ backend, fake } = makeBackend());
  });

  it('不在のときだけ作成し、既存は壊さない', async () => {
    const items = backend.collection<Item>('cond_demo');
    await expect(items.putIfAbsent({ id: 'a', label: 'first' })).resolves.toBe(true);
    await expect(items.putIfAbsent({ id: 'a', label: 'second' })).resolves.toBe(false);
    await expect(items.get('a')).resolves.toMatchObject({ label: 'first' });
  });

  /*
   * 🔴 **どの原始操作を使ったかを縛る。** 条件式を落とす／`attribute_exists` へ反転する変異は、
   * 結果だけ見ていると memory backend の緑に隠れる。反転すると本番では
   * 「初回作成が常に 409」＝緊急停止を初めて設定する拠点が保存できない、という形で出る。
   */
  it('attribute_not_exists(PK) を条件に付けて書き込む', async () => {
    const items = backend.collection<Item>('cond_expr');
    await items.putIfAbsent({ id: 'a', label: 'first' });
    const put = fake.calls.find((c) => c.name === 'PutCommand');
    expect(put?.input.ConditionExpression).toBe('attribute_not_exists(#pk)');
    expect(put?.input.ExpressionAttributeNames).toMatchObject({ '#pk': 'PK' });
  });

  it('FakeDoc は未対応の条件式を「条件不成立」に倒さない', async () => {
    /*
     * 未知の式を false にすると、次の増分で別の条件式を使ったとき**偽の 409**が静かに出る。
     * テストダブルの弱点は本体の欠陥より見つけにくいので、ここで表明しておく。
     */
    const fakeDoc = new FakeDoc();
    await expect(
      fakeDoc.send(
        new PutCommand({
          TableName: 't',
          Item: { PK: 'p', SK: 's' },
          ConditionExpression: 'size(#a) > :n',
          ExpressionAttributeNames: { '#a': 'a' },
        }),
      ),
    ).rejects.toThrow('unsupported ConditionExpression');
  });

  it('条件以外の例外は握り潰さない', async () => {
    const items = backend.collection<Item>('cond_throw');
    fake.failNextPut = Object.assign(new Error('boom'), { name: 'ProvisionedThroughputExceededException' });
    await expect(items.putIfAbsent({ id: 'a', label: 'x' })).rejects.toThrow('boom');
  });
});

describe('DynamoBackend collection listByIndex() の境界クエリ (#274/#284)', () => {
  type Scoped = { id: string; tenantId: string };
  let backend: DynamoBackend;
  let fake: FakeDoc;
  beforeEach(() => {
    ({ backend, fake } = makeBackend());
  });

  it('put は indexedField の値から GSI1 キーを書き込む（write-through）', async () => {
    const col = backend.collection<Scoped>('device', { indexedField: 'tenantId' });
    await col.put({ id: 'd1', tenantId: 't-a' });
    const raw = [...fake.store.values()][0]!;
    expect(raw.GSI1PK).toBe('col#device#idx#t-a');
    expect(raw.GSI1SK).toBe('d1');
  });

  it('listByIndex は GSI1 の境界クエリで値一致のみ返す（内部キーは strip）', async () => {
    const col = backend.collection<Scoped>('device', { indexedField: 'tenantId' });
    await col.put({ id: 'a1', tenantId: 't-a' });
    await col.put({ id: 'a2', tenantId: 't-a' });
    await col.put({ id: 'b1', tenantId: 't-b' });
    fake.queries = [];
    const rows = await col.listByIndex('t-a');
    expect(rows.map((r) => r.id).sort()).toEqual(['a1', 'a2']);
    expect(rows[0]).not.toHaveProperty('GSI1PK');
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0]!.IndexName).toBe('GSI1');
    expect(fake.queries[0]!.Limit).toBe(DEFAULT_COLLECTION_LIST_LIMIT);
  });

  it('listByIndex は複数ページにまたがっても上限で打ち切り、warn を出す', async () => {
    const col = backend.collection<Scoped>('device', { indexedField: 'tenantId' });
    for (let i = 0; i < 5; i += 1) await col.put({ id: `d${i}`, tenantId: 't' });
    fake.pageSize = 2;
    fake.queries = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rows = await col.listByIndex('t', { limit: 3 });
    expect(rows).toHaveLength(3);
    expect(fake.queries).toHaveLength(2);
    expect(fake.queries[1]!.Limit).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('device'));
    warn.mockRestore();
  });

  it('indexedField 未設定の collection では設定ミスとして throw する（fail-fast）', async () => {
    const col = backend.collection<Scoped>('unindexed');
    await expect(col.listByIndex('t')).rejects.toThrow(/indexedField/);
  });
});

describe('DynamoBackend singleton', () => {
  it('returns undefined before write, persists object, strips keys', async () => {
    const { backend, fake } = makeBackend();
    const s = backend.singleton<{ a: number; b?: string }>('voice');
    expect(await s.get()).toBeUndefined();
    await s.put({ a: 1 });
    expect(await s.get()).toEqual({ a: 1 });
    const raw = [...fake.store.values()][0]!;
    expect(raw.PK).toBe('config');
    expect(raw.SK).toBe('voice');
  });
});

describe('DynamoBackend log', () => {
  it('lists newest-first by timestamp field', async () => {
    const { backend } = makeBackend();
    const log = backend.log<{ id: string; at: string }>('audit', { timestampField: 'at' });
    await log.put({ id: '1', at: '2026-01-01T00:00:00.000Z' });
    await log.put({ id: '2', at: '2026-01-02T00:00:00.000Z' });
    await log.put({ id: '3', at: '2026-01-03T00:00:00.000Z' });
    const list = await log.list();
    expect(list.map((l) => l.id)).toEqual(['3', '2', '1']);
  });

  it('listSince returns only logs at/after the timestamp, newest-first（#254）', async () => {
    const { backend } = makeBackend();
    const log = backend.log<{ id: string; at: string }>('audit', { timestampField: 'at' });
    await log.put({ id: '1', at: '2026-01-01T00:00:00.000Z' });
    await log.put({ id: '2', at: '2026-01-02T00:00:00.000Z' });
    await log.put({ id: '3', at: '2026-01-03T00:00:00.000Z' });
    // since=01-02（含む）→ 2,3 のみ、新しい順。
    const since = await log.listSince('2026-01-02T00:00:00.000Z');
    expect(since.map((l) => l.id)).toEqual(['3', '2']);
    // 全件より前の since → 全件。
    expect((await log.listSince('2025-01-01T00:00:00.000Z')).map((l) => l.id)).toEqual(['3', '2', '1']);
  });

  it('findBy uses the GSI for the indexed field', async () => {
    const { backend, fake } = makeBackend();
    const log = backend.log<{ id: string; createdAt: string; receptionId: string }>('rcplog', {
      timestampField: 'createdAt',
      indexedField: 'receptionId',
    });
    await log.put({ id: 'l1', createdAt: '2026-01-01T00:00:00.000Z', receptionId: 'rec-1' });
    await log.put({ id: 'l2', createdAt: '2026-01-02T00:00:00.000Z', receptionId: 'rec-2' });

    const raw = [...fake.store.values()].find((i) => i.SK === '2026-01-01T00:00:00.000Z#l1')!;
    expect(raw.GSI1PK).toBe('log#rcplog#idx#rec-1');

    const found = await log.findBy('receptionId', 'rec-2');
    expect(found?.id).toBe('l2');
    expect(await log.findBy('receptionId', 'missing')).toBeUndefined();
  });

  it('put overwrites an item with the same id (patch fallbackUsed)', async () => {
    const { backend } = makeBackend();
    const log = backend.log<{ id: string; createdAt: string; fallbackUsed: boolean }>('rcplog', {
      timestampField: 'createdAt',
    });
    await log.put({ id: 'l1', createdAt: '2026-01-01T00:00:00.000Z', fallbackUsed: false });
    await log.put({ id: 'l1', createdAt: '2026-01-01T00:00:00.000Z', fallbackUsed: true });
    const list = await log.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.fallbackUsed).toBe(true);
  });

  it('propagates an item-level ttl field into the raw record and strips it on read (issue #313 — reuses the existing TTL attribute, no LogOpts change needed)', async () => {
    const { backend, fake } = makeBackend();
    const log = backend.log<{ id: string; createdAt: string; ttl?: number }>('rcplog', {
      timestampField: 'createdAt',
    });
    const ttl = Math.floor(Date.now() / 1000) + 3600;
    await log.put({ id: 'l1', createdAt: '2026-01-01T00:00:00.000Z', ttl });

    const raw = [...fake.store.values()][0]!;
    expect(raw.ttl).toBe(ttl); // 既存の TTL 属性（`ttl`, epoch 秒）へそのまま乗る。

    const [got] = await log.list();
    expect(got).not.toHaveProperty('ttl'); // strip() で内部属性として除去される。
  });
});
