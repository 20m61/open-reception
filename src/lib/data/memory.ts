/**
 * in-memory バックエンド (docs/persistence-design.md §3)。
 * プロセス内 Map/配列で保持する。dev / test / CI 用（単一インスタンス前提）。
 *
 * 同一プロセス内で同じ name を要求すると同じハンドルを返し、状態を共有する。
 * seed は構築時と reset() 時に適用する。
 */
import {
  DEFAULT_COLLECTION_LIST_LIMIT,
  type Collection,
  type CollectionOpts,
  type DataBackend,
  type ListOptions,
  type LogOpts,
  type LogStore,
  type Singleton,
} from './backend';

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryCollection<T extends { id: string }> implements Collection<T> {
  private items = new Map<string, T>();

  constructor(
    private readonly name: string,
    private readonly seed?: () => T[],
    private readonly indexedField?: string,
  ) {
    this.applySeed();
  }

  private applySeed(): void {
    this.items.clear();
    for (const item of this.seed?.() ?? []) {
      this.items.set(item.id, clone(item));
    }
  }

  // 上限つき list（#274）。dynamo バックエンドの Limit 強制と挙動を揃える。
  async list(options?: ListOptions): Promise<T[]> {
    const limit = options?.limit ?? DEFAULT_COLLECTION_LIST_LIMIT;
    if (!Number.isFinite(limit) || limit <= 0) return [];
    const all = [...this.items.values()];
    if (all.length > limit) {
      // サイレント欠落を避けるため、切り詰めの発生は必ず可視化する（境界クエリ移行の合図, #284）。
      console.warn(
        `[data] collection '${this.name}' list() truncated to ${limit} of ${all.length} items (#274). 境界付きクエリへの移行を検討すること。`,
      );
    }
    return all.slice(0, limit).map(clone);
  }

  // indexedField の値一致のみ返す境界クエリ（#274/#284）。dynamo の GSI1 Query と等価挙動
  // （memory は走査フィルタで実現。単一プロセスの dev/test 用なので走査で十分）。
  async listByIndex(value: string, options?: ListOptions): Promise<T[]> {
    if (!this.indexedField) {
      throw new Error(
        `collection '${this.name}' has no indexedField; configure CollectionOpts.indexedField to use listByIndex (#274/#284).`,
      );
    }
    const limit = options?.limit ?? DEFAULT_COLLECTION_LIST_LIMIT;
    if (!Number.isFinite(limit) || limit <= 0) return [];
    const field = this.indexedField;
    const matched = [...this.items.values()].filter(
      (item) => String((item as Record<string, unknown>)[field] ?? '') === value,
    );
    if (matched.length > limit) {
      console.warn(
        `[data] collection '${this.name}' listByIndex('${value}') truncated to ${limit} of ${matched.length} items (#274/#284).`,
      );
    }
    return matched.slice(0, limit).map(clone);
  }

  async get(id: string): Promise<T | undefined> {
    const found = this.items.get(id);
    return found ? clone(found) : undefined;
  }

  async put(item: T): Promise<void> {
    this.items.set(item.id, clone(item));
  }

  // get→check→部分更新→set を await を挟まず同期で行うため、単一スレッドの event loop 上で原子的。
  // **現在値**から changes のフィールドだけを変えるので、他フィールドの並行更新を失わない。
  async updateIf(id: string, changes: Partial<T>, expected: Partial<T>): Promise<boolean> {
    const cur = this.items.get(id);
    if (!cur) return false;
    for (const key of Object.keys(expected) as (keyof T)[]) {
      // プリミティブ前提（dynamo の値比較と揃える）。一致しなければ更新しない。
      if (cur[key] !== expected[key]) return false;
    }
    this.items.set(id, clone({ ...cur, ...changes }));
    return true;
  }

  async remove(id: string): Promise<void> {
    this.items.delete(id);
  }

  async reset(): Promise<void> {
    this.applySeed();
  }
}

class MemorySingleton<T> implements Singleton<T> {
  private value: T | undefined;

  constructor(private readonly makeDefault?: () => T) {
    this.value = makeDefault ? clone(makeDefault()) : undefined;
  }

  async get(): Promise<T | undefined> {
    return this.value === undefined ? undefined : clone(this.value);
  }

  async put(value: T): Promise<void> {
    this.value = clone(value);
  }

  async reset(): Promise<void> {
    this.value = this.makeDefault ? clone(this.makeDefault()) : undefined;
  }
}

class MemoryLogStore<T extends { id: string }> implements LogStore<T> {
  private items: T[] = [];

  constructor(private readonly tsField: string) {}

  async put(item: T): Promise<void> {
    const idx = this.items.findIndex((i) => i.id === item.id);
    if (idx >= 0) this.items[idx] = clone(item);
    else this.items.push(clone(item));
  }

  async list(): Promise<T[]> {
    const ts = (i: T) => String((i as Record<string, unknown>)[this.tsField] ?? '');
    return [...this.items]
      .sort((a, b) => (ts(a) < ts(b) ? 1 : ts(a) > ts(b) ? -1 : a.id < b.id ? 1 : -1))
      .map(clone);
  }

  async listSince(sinceIso: string): Promise<T[]> {
    // dynamo の `SK >= :since` と揃える（timestampField >= sinceIso を含む）。捨てる分を clone しないよう
    // filter を先に、その後 list と同じ新しい順ソート＋clone。
    const ts = (i: T) => String((i as Record<string, unknown>)[this.tsField] ?? '');
    return [...this.items]
      .filter((i) => ts(i) >= sinceIso)
      .sort((a, b) => (ts(a) < ts(b) ? 1 : ts(a) > ts(b) ? -1 : a.id < b.id ? 1 : -1))
      .map(clone);
  }

  async findBy(field: keyof T & string, value: string): Promise<T | undefined> {
    // DynamoDB の GSI（ScanIndexForward:false, Limit:1）と一致させ、最新の 1 件を返す。
    const ts = (i: T) => String((i as Record<string, unknown>)[this.tsField] ?? '');
    const found = [...this.items]
      .sort((a, b) => (ts(a) < ts(b) ? 1 : ts(a) > ts(b) ? -1 : a.id < b.id ? 1 : -1))
      .find((i) => i[field] === value);
    return found ? clone(found) : undefined;
  }

  async reset(): Promise<void> {
    this.items = [];
  }
}

/** 同一 name のハンドルを共有するための memory バックエンド。 */
export class MemoryBackend implements DataBackend {
  private collections = new Map<string, MemoryCollection<{ id: string }>>();
  private singletons = new Map<string, MemorySingleton<unknown>>();
  private logs = new Map<string, MemoryLogStore<{ id: string }>>();

  collection<T extends { id: string }>(name: string, opts?: CollectionOpts<T>): Collection<T> {
    let existing = this.collections.get(name);
    if (!existing) {
      existing = new MemoryCollection<{ id: string }>(
        name,
        opts?.seed as (() => { id: string }[]) | undefined,
        opts?.indexedField,
      );
      this.collections.set(name, existing);
    }
    return existing as unknown as Collection<T>;
  }

  singleton<T>(name: string, opts?: { default?: () => T }): Singleton<T> {
    let existing = this.singletons.get(name);
    if (!existing) {
      existing = new MemorySingleton<unknown>(opts?.default as (() => unknown) | undefined);
      this.singletons.set(name, existing);
    }
    return existing as Singleton<T>;
  }

  log<T extends { id: string }>(name: string, opts: LogOpts<T>): LogStore<T> {
    let existing = this.logs.get(name);
    if (!existing) {
      existing = new MemoryLogStore<{ id: string }>(opts.timestampField as string);
      this.logs.set(name, existing);
    }
    return existing as unknown as LogStore<T>;
  }
}
