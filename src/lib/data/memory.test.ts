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
