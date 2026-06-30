/**
 * DynamoDB バックエンド (docs/persistence-design.md §4)。
 *
 * シングルテーブル設計。PK/SK 複合キーで全エンティティを収容する。
 *   - コレクション : PK=`col#<name>`,  SK=<id>
 *   - シングルトン : PK=`config`,       SK=<name>
 *   - ログ         : PK=`log#<name>`,  SK=`<timestamp>#<id>`
 *                    （indexedField 指定時は GSI1: GSI1PK=`log#<name>#idx#<value>`, GSI1SK=SK）
 * TTL 属性は `ttl`（epoch 秒）。受付セッションのみ付与する。
 *
 * DocumentClient はモジュール読み込み時に 1 度だけ生成し、コールドスタートを抑える。
 * このモジュールは getBackend()（DATA_BACKEND=dynamodb）からのみ遅延 import される。
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  Collection,
  CollectionOpts,
  DataBackend,
  LogOpts,
  LogStore,
  Singleton,
} from './backend';

const GSI1 = 'GSI1';
const META_KEYS = ['PK', 'SK', 'ttl', 'GSI1PK', 'GSI1SK'] as const;

type Item = Record<string, unknown>;

function strip<T>(item: Item | undefined): T | undefined {
  if (!item) return undefined;
  const out: Item = { ...item };
  for (const k of META_KEYS) delete out[k];
  return out as T;
}

function makeClient(): { doc: DynamoDBDocumentClient; table: string } {
  const table = process.env.TABLE_NAME;
  if (!table) {
    throw new Error('TABLE_NAME env var is required when DATA_BACKEND=dynamodb.');
  }
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'ap-northeast-1';
  const client = new DynamoDBClient({ region });
  const doc = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
  return { doc, table };
}

class DynamoCollection<T extends { id: string }> implements Collection<T> {
  private readonly pk: string;

  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
    name: string,
    private readonly ttlSeconds?: number,
  ) {
    this.pk = `col#${name}`;
  }

  async list(): Promise<T[]> {
    const items: Item[] = [];
    let start: Item | undefined;
    do {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': this.pk },
          ExclusiveStartKey: start,
        }),
      );
      items.push(...((res.Items as Item[]) ?? []));
      start = res.LastEvaluatedKey as Item | undefined;
    } while (start);
    return items.map((i) => strip<T>(i)!);
  }

  async get(id: string): Promise<T | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { PK: this.pk, SK: id } }),
    );
    return strip<T>(res.Item as Item | undefined);
  }

  async put(item: T): Promise<void> {
    const record: Item = { ...item, PK: this.pk, SK: item.id };
    if (this.ttlSeconds && this.ttlSeconds > 0) {
      record.ttl = Math.floor(Date.now() / 1000) + this.ttlSeconds;
    }
    await this.doc.send(new PutCommand({ TableName: this.table, Item: record }));
  }

  // 条件付き**部分更新**（UpdateItem）。expected が現在値と一致するときのみ changes を適用。
  // アイテム全体を置換しないため他フィールドの並行更新を失わない（lost-update 回避）。
  // フィールドは top-level 属性として格納されるため式で直接参照できる。
  async updateIf(id: string, changes: Partial<T>, expected: Partial<T>): Promise<boolean> {
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const sets: string[] = [];
    const removes: string[] = [];
    let n = 0;
    for (const [k, v] of Object.entries(changes)) {
      const nm = `#u${n}`;
      names[nm] = k;
      if (v === undefined) {
        removes.push(nm); // 属性削除（REMOVE）。
      } else {
        values[`:u${n}`] = v;
        sets.push(`${nm} = :u${n}`);
      }
      n += 1;
    }
    // 期待条件（expected）を組み立てる。undefined は属性不在を要求。どの場合も **対象の存在** を
    // 必須にする（attribute_exists(PK)）。これにより不在 id への upsert を防ぎ、「対象が存在しない
    // なら false」という契約を memory backend と揃える。
    names['#pk'] = 'PK';
    const conds: string[] = ['attribute_exists(#pk)'];
    let c = 0;
    for (const [k, v] of Object.entries(expected)) {
      const nm = `#c${c}`;
      names[nm] = k;
      if (v === undefined) {
        conds.push(`attribute_not_exists(${nm})`);
      } else {
        values[`:c${c}`] = v;
        conds.push(`${nm} = :c${c}`);
      }
      c += 1;
    }

    const updateParts: string[] = [];
    if (sets.length) updateParts.push(`SET ${sets.join(', ')}`);
    if (removes.length) updateParts.push(`REMOVE ${removes.join(', ')}`);

    // changes が空（書込なしの純粋な CAS 表明）: UpdateItem は空の式を許さないため read して
    // expected を評価する。書込が無いので原子性の懸念もなく、memory backend と同義になる。
    if (updateParts.length === 0) {
      const cur = await this.get(id);
      if (!cur) return false;
      return Object.entries(expected).every(
        ([k, v]) => (cur as Record<string, unknown>)[k] === v,
      );
    }

    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: this.pk, SK: id },
          UpdateExpression: updateParts.join(' '),
          ConditionExpression: conds.join(' AND '),
          ExpressionAttributeNames: names,
          ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
        }),
      );
      return true;
    } catch (e) {
      if ((e as { name?: string })?.name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  }

  async remove(id: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.table, Key: { PK: this.pk, SK: id } }),
    );
  }

  async reset(): Promise<void> {
    // DynamoDB では seed/reset は行わない（運用データを保持する）。
  }
}

class DynamoSingleton<T> implements Singleton<T> {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly name: string,
  ) {}

  async get(): Promise<T | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { PK: 'config', SK: this.name } }),
    );
    return strip<T>(res.Item as Item | undefined);
  }

  async put(value: T): Promise<void> {
    const record: Item = { ...(value as Item), PK: 'config', SK: this.name };
    await this.doc.send(new PutCommand({ TableName: this.table, Item: record }));
  }

  async reset(): Promise<void> {
    // no-op（DynamoDB）。
  }
}

class DynamoLogStore<T extends { id: string }> implements LogStore<T> {
  private readonly pk: string;

  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly name: string,
    private readonly tsField: string,
    private readonly indexedField?: string,
  ) {
    this.pk = `log#${name}`;
  }

  private sk(item: T): string {
    const ts = String((item as Item)[this.tsField] ?? '');
    return `${ts}#${item.id}`;
  }

  async put(item: T): Promise<void> {
    const record: Item = { ...item, PK: this.pk, SK: this.sk(item) };
    if (this.indexedField) {
      const value = String((item as Item)[this.indexedField] ?? '');
      record.GSI1PK = `log#${this.name}#idx#${value}`;
      record.GSI1SK = record.SK;
    }
    await this.doc.send(new PutCommand({ TableName: this.table, Item: record }));
  }

  async list(): Promise<T[]> {
    const items: Item[] = [];
    let start: Item | undefined;
    do {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': this.pk },
          ScanIndexForward: false, // 新しい順
          ExclusiveStartKey: start,
        }),
      );
      items.push(...((res.Items as Item[]) ?? []));
      start = res.LastEvaluatedKey as Item | undefined;
    } while (start);
    return items.map((i) => strip<T>(i)!);
  }

  async findBy(field: keyof T & string, value: string): Promise<T | undefined> {
    if (this.indexedField && field === this.indexedField) {
      const res = await this.doc.send(
        new QueryCommand({
          TableName: this.table,
          IndexName: GSI1,
          KeyConditionExpression: 'GSI1PK = :g',
          ExpressionAttributeValues: { ':g': `log#${this.name}#idx#${value}` },
          ScanIndexForward: false,
          Limit: 1,
        }),
      );
      return strip<T>((res.Items as Item[] | undefined)?.[0]);
    }
    // インデックス外フィールドはパーティション走査でフォールバック（ログは小規模）。
    const all = await this.list();
    return all.find((i) => (i as Item)[field] === value);
  }

  async reset(): Promise<void> {
    // no-op（DynamoDB）。
  }
}

export class DynamoBackend implements DataBackend {
  private readonly doc: DynamoDBDocumentClient;
  private readonly table: string;

  /** 通常は引数なし（env から client を生成）。テストでは fake client を注入できる。 */
  constructor(deps?: { doc: DynamoDBDocumentClient; table: string }) {
    if (deps) {
      this.doc = deps.doc;
      this.table = deps.table;
    } else {
      const { doc, table } = makeClient();
      this.doc = doc;
      this.table = table;
    }
  }

  collection<T extends { id: string }>(name: string, opts?: CollectionOpts<T>): Collection<T> {
    return new DynamoCollection<T>(this.doc, this.table, name, opts?.ttlSeconds);
  }

  singleton<T>(name: string, _opts?: { default?: () => T }): Singleton<T> {
    // _opts.default は memory バックエンド専用。DynamoDB では未保存時 undefined を返し、
    // 呼び出し側が DEFAULTS にフォールバックする（interface 互換のため引数は受ける）。
    return new DynamoSingleton<T>(this.doc, this.table, name);
  }

  log<T extends { id: string }>(name: string, opts: LogOpts<T>): LogStore<T> {
    return new DynamoLogStore<T>(
      this.doc,
      this.table,
      name,
      opts.timestampField as string,
      opts.indexedField as string | undefined,
    );
  }
}
