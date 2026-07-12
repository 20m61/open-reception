/**
 * MemoryBackend の単体テスト（#274 inc1: Collection.list() の境界化）。
 *
 * list() はパーティション内無境界だったため、既定上限（DEFAULT_COLLECTION_LIST_LIMIT）と
 * options.limit による明示上限を memory バックエンドが強制することを検証する。
 * dynamodb 側の同挙動は dynamodb.test.ts（Limit パラメータ組み立て）で検証する。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DEFAULT_COLLECTION_LIST_LIMIT } from './backend';
import { MemoryBackend } from './memory';

type Row = { id: string; n: number };

function seedRows(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({ id: `r${String(i).padStart(4, '0')}`, n: i }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MemoryBackend collection list() の境界化 (#274)', () => {
  it('既定では DEFAULT_COLLECTION_LIST_LIMIT 件に切り詰め、warn を出す', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const backend = new MemoryBackend();
    const col = backend.collection<Row>('bulk', {
      seed: () => seedRows(DEFAULT_COLLECTION_LIST_LIMIT + 10),
    });
    const list = await col.list();
    expect(list).toHaveLength(DEFAULT_COLLECTION_LIST_LIMIT);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bulk'));
  });

  it('options.limit で明示した上限を強制する', async () => {
    const backend = new MemoryBackend();
    const col = backend.collection<Row>('bounded', { seed: () => seedRows(20) });
    expect(await col.list({ limit: 5 })).toHaveLength(5);
  });

  it('件数が上限未満なら全件返し、warn しない', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const backend = new MemoryBackend();
    const col = backend.collection<Row>('small', { seed: () => seedRows(3) });
    expect(await col.list()).toHaveLength(3);
    expect(await col.list({ limit: 10 })).toHaveLength(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it('limit が 0 以下なら空配列（防御的動作）', async () => {
    const backend = new MemoryBackend();
    const col = backend.collection<Row>('zero', { seed: () => seedRows(3) });
    expect(await col.list({ limit: 0 })).toEqual([]);
    expect(await col.list({ limit: -1 })).toEqual([]);
  });

  it('返す配列は clone であり、変更してもストアへ波及しない（既存契約の維持）', async () => {
    const backend = new MemoryBackend();
    const col = backend.collection<Row>('clone', { seed: () => seedRows(2) });
    const first = await col.list({ limit: 10 });
    first[0]!.n = 999;
    const second = await col.list({ limit: 10 });
    expect(second.find((r) => r.id === first[0]!.id)?.n).not.toBe(999);
  });
});

type Scoped = { id: string; tenantId: string; n?: number };

describe('MemoryBackend collection listByIndex() の境界クエリ (#274/#284)', () => {
  it('indexedField の値一致のみ返す（他スコープを混ぜない）', async () => {
    const backend = new MemoryBackend();
    const col = backend.collection<Scoped>('scoped', {
      indexedField: 'tenantId',
      seed: () => [
        { id: 'a1', tenantId: 't-a' },
        { id: 'a2', tenantId: 't-a' },
        { id: 'b1', tenantId: 't-b' },
      ],
    });
    const rows = await col.listByIndex('t-a');
    expect(rows.map((r) => r.id).sort()).toEqual(['a1', 'a2']);
  });

  it('put した項目も listByIndex で引ける（write-through）', async () => {
    const backend = new MemoryBackend();
    const col = backend.collection<Scoped>('scoped-put', { indexedField: 'tenantId' });
    await col.put({ id: 'x1', tenantId: 't-x' });
    expect((await col.listByIndex('t-x')).map((r) => r.id)).toEqual(['x1']);
    expect(await col.listByIndex('t-other')).toEqual([]);
  });

  it('limit を強制し、切り詰め時は warn を出す', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const backend = new MemoryBackend();
    const col = backend.collection<Scoped>('scoped-bulk', {
      indexedField: 'tenantId',
      seed: () => Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, tenantId: 't' })),
    });
    expect(await col.listByIndex('t', { limit: 3 })).toHaveLength(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('scoped-bulk'));
  });

  it('返す配列は clone（変更がストアへ波及しない）', async () => {
    const backend = new MemoryBackend();
    const col = backend.collection<Scoped>('scoped-clone', {
      indexedField: 'tenantId',
      seed: () => [{ id: 'c1', tenantId: 't', n: 1 }],
    });
    const rows = await col.listByIndex('t');
    rows[0]!.n = 999;
    expect((await col.listByIndex('t'))[0]?.n).toBe(1);
  });

  it('indexedField 未設定の collection では設定ミスとして throw する（fail-fast）', async () => {
    const backend = new MemoryBackend();
    const col = backend.collection<Scoped>('unindexed');
    await expect(col.listByIndex('t')).rejects.toThrow(/indexedField/);
  });
});

/**
 * MemoryLogStore の読み取り時 TTL 判定 (issue #313)。
 * dynamo の `ttl`（epoch 秒）属性と同じフィールドを item が持つとき、期限切れを list/listSince/
 * findBy から除外する（`platform/repository.ts` の expiresAt 方式に倣う）。実削除はしない。
 */
type LogRow = { id: string; createdAt: string; ttl?: number };

describe('MemoryBackend log() の読み取り時 TTL 判定 (#313)', () => {
  it('ttl が未来のレコードは list/listSince/findBy に現れ、ttl フィールドは返却時に取り除かれる', async () => {
    const backend = new MemoryBackend();
    const log = backend.log<LogRow>('rcplog-ttl', { timestampField: 'createdAt' });
    const future = Math.floor(Date.now() / 1000) + 3600;
    await log.put({ id: 'a', createdAt: '2026-07-01T00:00:00.000Z', ttl: future });

    const list = await log.list();
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('ttl');
  });

  it('ttl が過去のレコードは list/listSince/findBy から除外される（削除はしない・put 直後の再 list では消えている）', async () => {
    const backend = new MemoryBackend();
    const log = backend.log<LogRow>('rcplog-ttl-expired', { timestampField: 'createdAt' });
    const past = Math.floor(Date.now() / 1000) - 1;
    await log.put({ id: 'a', createdAt: '2026-07-01T00:00:00.000Z', ttl: past });
    await log.put({ id: 'b', createdAt: '2026-07-02T00:00:00.000Z' }); // ttl 無し = 非期限

    expect((await log.list()).map((l) => l.id)).toEqual(['b']);
    expect((await log.listSince('2026-01-01T00:00:00.000Z')).map((l) => l.id)).toEqual(['b']);
    expect(await log.findBy('id', 'a')).toBeUndefined();
    expect((await log.findBy('id', 'b'))?.id).toBe('b');
  });

  it('ttl フィールドを持たない item は従来どおり常に返る（他の LogStore 利用への非破壊）', async () => {
    const backend = new MemoryBackend();
    const log = backend.log<{ id: string; at: string }>('audit-ttl-none', { timestampField: 'at' });
    await log.put({ id: 'a', at: '2026-07-01T00:00:00.000Z' });
    expect((await log.list()).map((l) => l.id)).toEqual(['a']);
  });
});
