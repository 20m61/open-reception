/**
 * in-memory バックエンド (docs/persistence-design.md §3)。
 * プロセス内 Map/配列で保持する。dev / test / CI 用（単一インスタンス前提）。
 *
 * 同一プロセス内で同じ name を要求すると同じハンドルを返し、状態を共有する。
 * seed は構築時と reset() 時に適用する。
 */
import type {
  Collection,
  CollectionOpts,
  DataBackend,
  LogOpts,
  LogStore,
  Singleton,
} from './backend';

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryCollection<T extends { id: string }> implements Collection<T> {
  private items = new Map<string, T>();

  constructor(private readonly seed?: () => T[]) {
    this.applySeed();
  }

  private applySeed(): void {
    this.items.clear();
    for (const item of this.seed?.() ?? []) {
      this.items.set(item.id, clone(item));
    }
  }

  async list(): Promise<T[]> {
    return [...this.items.values()].map(clone);
  }

  async get(id: string): Promise<T | undefined> {
    const found = this.items.get(id);
    return found ? clone(found) : undefined;
  }

  async put(item: T): Promise<void> {
    this.items.set(item.id, clone(item));
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
      existing = new MemoryCollection<{ id: string }>(opts?.seed as (() => { id: string }[]) | undefined);
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
