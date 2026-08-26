/**
 * PK/SK をキーにした最小の DynamoDB エミュレータ（テスト専用）。
 *
 * 🔴 **複製しないこと。** `dynamodb.test.ts` と `update-if-contract.test.ts` の両方が
 * これを使う。同じものを 2 つ書くと片方だけ実装に追随して、**本番の意味が変わったのに
 * 片側だけ緑のまま**になる（このリポジトリは「影の定数」で一度この形を踏んでいる）。
 */
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { DynamoBackend } from './dynamodb';

export type Item = Record<string, unknown>;

/** PK/SK をキーにした最小の DynamoDB エミュレータ。 */
export class FakeDoc {
  store = new Map<string, Item>();
  /** 送信された QueryCommand の input（Limit 等のコマンド組み立てを検証する用, #274）。 */
  queries: Item[] = [];
  /** 1 ページの最大件数（実 DynamoDB の 1MB 制限の代替。pagination ループの検証用, #274）。 */
  pageSize?: number;
  /** 送信されたコマンド（どの原始操作を使ったかを縛る用, #367）。 */
  calls: { name: string; input: Item }[] = [];
  /** 次の PutCommand で投げる例外（条件失敗以外の握り潰しを検出する用, #367）。 */
  failNextPut?: Error;

  private key(pk: unknown, sk: unknown): string {
    // `\u0000` をそのまま書くとファイルが git 上バイナリ扱いになり、diff が
    // 「Binary files differ」に潰れる（レビューで実際に見えなくなった）。エスケープで書く。
    return `${String(pk)}\u0000${String(sk)}`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async send(command: any): Promise<any> {
    const input = command.input as Item;
    this.calls.push({ name: command.constructor.name, input: input as Item });
    if (command instanceof PutCommand) {
      if (this.failNextPut) {
        const err = this.failNextPut;
        this.failNextPut = undefined;
        throw err;
      }
      /*
       * 🔴 **条件式を評価する。** `putIfAbsent`（#367）が `attribute_not_exists(PK)` 付きの
       * PutCommand を投げるようになった。ここで無条件に成功させると、条件を外す変異も
       * `attribute_exists` へ反転する変異も緑のまま通り、**本番だけが壊れる**。
       */
      const item = input.Item as Item;
      const k = this.key(item.PK, item.SK);
      const cur = this.store.get(k);
      const cond = input.ConditionExpression as string | undefined;
      if (cond) {
        const names = (input.ExpressionAttributeNames as Record<string, string>) ?? {};
        const ok = cond.split(' AND ').every((c) => {
          const t = c.trim();
          const notExists = t.match(/^attribute_not_exists\((#\w+)\)$/);
          if (notExists) return cur === undefined || cur[names[notExists[1] ?? ''] ?? ''] === undefined;
          const exists = t.match(/^attribute_exists\((#\w+)\)$/);
          if (exists) return cur != null && cur[names[exists[1] ?? ''] ?? ''] !== undefined;
          // 未対応の式を「条件不成立」に倒すと、次に別の条件式を使ったとき**偽の 409**になる。
          throw new Error(`FakeDoc: unsupported ConditionExpression '${t}'`);
        });
        if (!ok) {
          throw Object.assign(new Error('conditional check failed'), {
            name: 'ConditionalCheckFailedException',
          });
        }
      }
      this.store.set(k, { ...item });
      return {};
    }
    if (command instanceof GetCommand) {
      const k = input.Key as Item;
      return { Item: this.store.get(this.key(k.PK, k.SK)) };
    }
    if (command instanceof UpdateCommand) {
      const k = input.Key as Item;
      const names = (input.ExpressionAttributeNames as Record<string, string>) ?? {};
      const values = (input.ExpressionAttributeValues as Item) ?? {};
      const cur = this.store.get(this.key(k.PK, k.SK));
      const cond = input.ConditionExpression as string | undefined;
      if (cond) {
        const ok =
          cur != null &&
          cond.split(' AND ').every((c) => {
            const t = c.trim();
            const exists = t.match(/^attribute_exists\((#\w+)\)$/);
            if (exists) return cur[names[exists[1] ?? ''] ?? ''] !== undefined;
            const notExists = t.match(/^attribute_not_exists\((#\w+)\)$/);
            if (notExists) return cur[names[notExists[1] ?? ''] ?? ''] === undefined;
            const [nameRef, valRef] = t.split(' = ');
            if (!nameRef || !valRef) return false;
            return cur[names[nameRef.trim()] ?? ''] === values[valRef.trim()];
          });
        if (!ok) {
          throw Object.assign(new Error('conditional check failed'), {
            name: 'ConditionalCheckFailedException',
          });
        }
      }
      const next: Item = { ...(cur ?? { PK: k.PK, SK: k.SK }) };
      const expr = input.UpdateExpression as string;
      const setM = expr.match(/SET (.+?)(?: REMOVE |$)/);
      if (setM?.[1]) {
        for (const a of setM[1].split(',')) {
          const [nameRef, valRef] = a.trim().split(' = ');
          if (!nameRef || !valRef) continue;
          next[names[nameRef.trim()] ?? ''] = values[valRef.trim()];
        }
      }
      const remM = expr.match(/REMOVE (.+)$/);
      if (remM?.[1]) {
        for (const nameRef of remM[1].split(',')) {
          delete next[names[nameRef.trim()] ?? ''];
        }
      }
      this.store.set(this.key(k.PK, k.SK), next);
      return {};
    }
    if (command instanceof DeleteCommand) {
      const k = input.Key as Item;
      this.store.delete(this.key(k.PK, k.SK));
      return {};
    }
    if (command instanceof QueryCommand) {
      this.queries.push({ ...input });
      const values = (input.ExpressionAttributeValues as Item) ?? {};
      const onGsi = input.IndexName === 'GSI1';
      const pkAttr = onGsi ? 'GSI1PK' : 'PK';
      const skAttr = onGsi ? 'GSI1SK' : 'SK';
      const pkVal = onGsi ? values[':g'] : values[':pk'];
      let items = [...this.store.values()].filter((i) => i[pkAttr] === pkVal);
      // KeyConditionExpression に `SK >= :since` があれば範囲で絞る（listSince）。
      const since = values[':since'];
      if (since !== undefined) items = items.filter((i) => String(i[skAttr]) >= String(since));
      items.sort((a, b) => (String(a[skAttr]) < String(b[skAttr]) ? -1 : 1));
      if (input.ScanIndexForward === false) items.reverse();
      // ExclusiveStartKey: 前ページ最終キーの「次」から再開する（並び順に沿って比較）。
      const startKey = input.ExclusiveStartKey as Item | undefined;
      if (startKey) {
        const startSk = String(startKey[skAttr]);
        items =
          input.ScanIndexForward === false
            ? items.filter((i) => String(i[skAttr]) < startSk)
            : items.filter((i) => String(i[skAttr]) > startSk);
      }
      const total = items.length;
      const cap = Math.min(
        typeof input.Limit === 'number' ? (input.Limit as number) : Infinity,
        this.pageSize ?? Infinity,
      );
      if (cap !== Infinity) items = items.slice(0, cap);
      // 残りがあるときのみ LastEvaluatedKey を返す（実 DynamoDB と同じ pagination 契約）。
      const lastItem = items[items.length - 1];
      const more = items.length < total && lastItem !== undefined;
      // 実 DynamoDB と同じく、GSI クエリの LastEvaluatedKey にはインデックスキーも含まれる。
      const lastKey = lastItem
        ? {
            PK: lastItem.PK,
            SK: lastItem.SK,
            ...(onGsi ? { GSI1PK: lastItem.GSI1PK, GSI1SK: lastItem.GSI1SK } : {}),
          }
        : undefined;
      return {
        Items: items,
        ...(more ? { LastEvaluatedKey: lastKey } : {}),
      };
    }
    throw new Error(`unsupported command: ${command?.constructor?.name}`);
  }
}


export function makeDynamoBackend(): { backend: DynamoBackend; fake: FakeDoc } {
  const fake = new FakeDoc();
  const backend = new DynamoBackend({ doc: fake as unknown as DynamoDBDocumentClient, table: 'T' });
  return { backend, fake };
}
