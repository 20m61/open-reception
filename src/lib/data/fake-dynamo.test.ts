/**
 * fake-dynamo 自身の契約（#1270 独立レビュー N1）。
 *
 * 本番の DocumentClient は `removeUndefinedValues: true`（`dynamodb.ts`）なので、
 * `ExpressionAttributeValues` の値が `undefined` だと marshall で落ちる。すると式は
 * **定義されていない値を参照する**形になり、実 DynamoDB は条件不成立ではなく
 * ValidationException を返す（仕様からの推定。実 DynamoDB では未測定）。
 *
 * fake がこれを `undefined === undefined` として「属性が無い」と同じに扱うと、
 * `attribute_not_exists(#c)` を `#c = :c`（`:c` は undefined）へ化けさせる変異（DY3）が
 * unit で生き残る。だから fake は**参照された値が無い・undefined なら throw する**。
 */
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { FakeDoc } from './fake-dynamo';

const KEY = { PK: 'col#d', SK: 'x' };

function seeded(): FakeDoc {
  const fake = new FakeDoc();
  fake.store.set(`col#d\u0000x`, { ...KEY, a: 1 });
  return fake;
}

async function nameOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { name?: string }).name;
  }
}

describe('FakeDoc: 式が参照する ExpressionAttributeValues', () => {
  describe('UpdateCommand', () => {
    const update = (input: Record<string, unknown>) =>
      new UpdateCommand({ TableName: 'T', Key: KEY, ...input } as never);

    it('条件式が undefined の値を参照したら ValidationException（条件不成立ではない）', async () => {
      // 属性 b は無い。undefined === undefined で「一致」にも「不成立」にもしない。
      for (const fake of [seeded(), new FakeDoc()]) {
        const before = JSON.stringify([...fake.store]);
        expect(
          await nameOf(
            fake.send(
              update({
                UpdateExpression: 'SET #u0 = :u0',
                ConditionExpression: 'attribute_exists(#pk) AND #c0 = :c0',
                ExpressionAttributeNames: { '#pk': 'PK', '#u0': 'a', '#c0': 'b' },
                ExpressionAttributeValues: { ':u0': 2, ':c0': undefined },
              }),
            ),
          ),
        ).toBe('ValidationException');
        expect(JSON.stringify([...fake.store]), '拒否したのに書き換わっている').toBe(before);
      }
    });

    it('条件式が ExpressionAttributeValues に無い値を参照したら ValidationException', async () => {
      const fake = seeded();
      expect(
        await nameOf(
          fake.send(
            update({
              UpdateExpression: 'SET #u0 = :u0',
              ConditionExpression: 'attribute_exists(#pk) AND #c0 = :c0',
              ExpressionAttributeNames: { '#pk': 'PK', '#u0': 'a', '#c0': 'b' },
              ExpressionAttributeValues: { ':u0': 2 },
            }),
          ),
        ),
      ).toBe('ValidationException');
      // ExpressionAttributeValues そのものが無い（全部 undefined で落ちた形）も同じ。
      expect(
        await nameOf(
          fake.send(
            update({
              UpdateExpression: 'REMOVE #u0',
              ConditionExpression: 'attribute_exists(#pk) AND #c0 = :c0',
              ExpressionAttributeNames: { '#pk': 'PK', '#u0': 'a', '#c0': 'b' },
            }),
          ),
        ),
      ).toBe('ValidationException');
    });

    it('更新式の SET が undefined の値を参照したら ValidationException', async () => {
      const fake = seeded();
      expect(
        await nameOf(
          fake.send(
            update({
              UpdateExpression: 'SET #u0 = :u0',
              ConditionExpression: 'attribute_exists(#pk)',
              ExpressionAttributeNames: { '#pk': 'PK', '#u0': 'a' },
              ExpressionAttributeValues: { ':u0': undefined },
            }),
          ),
        ),
      ).toBe('ValidationException');
      expect(fake.store.get(`col#d\u0000x`)).toEqual({ ...KEY, a: 1 });
    });

    it('下界: 値が揃っていれば従来どおり評価する（成立・不成立・null）', async () => {
      const fake = seeded();
      const base = {
        UpdateExpression: 'SET #u0 = :u0',
        ExpressionAttributeNames: { '#pk': 'PK', '#u0': 'a', '#c0': 'a' },
      };
      expect(
        await nameOf(
          fake.send(
            update({
              ...base,
              ConditionExpression: 'attribute_exists(#pk) AND #c0 = :c0',
              ExpressionAttributeValues: { ':u0': 2, ':c0': 9 },
            }),
          ),
        ),
      ).toBe('ConditionalCheckFailedException');
      expect(
        await nameOf(
          fake.send(
            update({
              ...base,
              ConditionExpression: 'attribute_exists(#pk) AND #c0 = :c0',
              ExpressionAttributeValues: { ':u0': null, ':c0': 1 },
            }),
          ),
        ),
      ).toBeUndefined();
      expect(fake.store.get(`col#d\u0000x`)).toEqual({ ...KEY, a: null });
      // 値を参照しない式（attribute_not_exists + REMOVE）は ExpressionAttributeValues 無しで通る。
      expect(
        await nameOf(
          fake.send(
            update({
              UpdateExpression: 'REMOVE #u0',
              ConditionExpression: 'attribute_exists(#pk) AND attribute_not_exists(#c1)',
              ExpressionAttributeNames: { '#pk': 'PK', '#u0': 'a', '#c1': 'b' },
            }),
          ),
        ),
      ).toBeUndefined();
      expect(fake.store.get(`col#d\u0000x`)).toEqual({ ...KEY });
    });
  });

  describe('PutCommand', () => {
    const put = (input: Record<string, unknown>) =>
      new PutCommand({ TableName: 'T', Item: { ...KEY, a: 5 }, ...input } as never);

    it('条件式が undefined の値・無い値を参照したら ValidationException（記録の有無によらない）', async () => {
      for (const fake of [seeded(), new FakeDoc()]) {
        const before = JSON.stringify([...fake.store]);
        expect(
          await nameOf(
            fake.send(
              put({
                ConditionExpression: '#c0 = :c0',
                ExpressionAttributeNames: { '#c0': 'b' },
                ExpressionAttributeValues: { ':c0': undefined },
              }),
            ),
          ),
        ).toBe('ValidationException');
        expect(
          await nameOf(
            fake.send(
              put({ ConditionExpression: '#c0 = :c0', ExpressionAttributeNames: { '#c0': 'b' } }),
            ),
          ),
        ).toBe('ValidationException');
        expect(JSON.stringify([...fake.store]), '拒否したのに書き換わっている').toBe(before);
      }
    });

    it('下界: 値が揃っていれば従来どおり評価する', async () => {
      const fake = seeded();
      expect(
        await nameOf(
          fake.send(
            put({
              ConditionExpression: '#c0 = :c0',
              ExpressionAttributeNames: { '#c0': 'a' },
              ExpressionAttributeValues: { ':c0': 2 },
            }),
          ),
        ),
      ).toBe('ConditionalCheckFailedException');
      expect(
        await nameOf(
          fake.send(
            put({
              ConditionExpression: '#c0 = :c0',
              ExpressionAttributeNames: { '#c0': 'a' },
              ExpressionAttributeValues: { ':c0': 1 },
            }),
          ),
        ),
      ).toBeUndefined();
      expect(fake.store.get(`col#d\u0000x`)).toEqual({ ...KEY, a: 5 });
    });
  });
});
