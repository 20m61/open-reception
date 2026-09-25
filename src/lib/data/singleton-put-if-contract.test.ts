/**
 * `Singleton.putIf`（条件付き置換）の意味論を **memory と dynamo の両方** で固定する契約テスト (#1158)。
 *
 * ## 守る不変条件
 *
 * > **`putIf` が true を返した ⟺ 書き込みの直前の記録が `expected` を満たしていた。
 * > false なら記録は 1 バイトも変わっていない。**
 *
 * `expected` の値が `undefined` のキーは「その属性が無い（記録そのものが無い場合を含む）」を要求する。
 * 旧レコード（版を持たない）と未作成の記録を、同じ 1 つの条件で扱うためである。
 *
 * memory は同期比較、dynamo は `PutItem` + `ConditionExpression` と**実装がまったく別**なので、
 * 片方だけが寛容になっても本番（dynamo）まで気づけない（`update-if-contract.test.ts` と同じ理由）。
 * fake の条件評価は自分で書いた述語なので、実エンジンとの一致は `dynamodb.emulator.test.ts` が見る。
 */
import { describe, expect, it } from 'vitest';
import type { DataBackend } from './backend';
import { makeDynamoBackend } from './fake-dynamo';
import { MemoryBackend } from './memory';

type Rec = { rev?: number; a: string; b?: string };

const BACKENDS: Array<[string, () => DataBackend]> = [
  ['memory', () => new MemoryBackend()],
  ['dynamo', () => makeDynamoBackend().backend],
];

for (const [label, make] of BACKENDS) {
  describe(`Singleton.putIf (${label})`, () => {
    const handle = () => make().singleton<Rec>('security');

    it('記録が無いとき、版が無いことを期待すれば作れる', async () => {
      const s = handle();
      expect(await s.putIf({ rev: 1, a: 'x' }, { rev: undefined })).toBe(true);
      expect(await s.get()).toEqual({ rev: 1, a: 'x' });
    });

    it('記録が無いとき、版を期待すると書かない', async () => {
      const s = handle();
      expect(await s.putIf({ rev: 2, a: 'x' }, { rev: 1 })).toBe(false);
      expect(await s.get()).toBeUndefined();
    });

    it('版が一致すれば記録ごと置き換える（部分更新ではない）', async () => {
      const s = handle();
      await s.put({ rev: 1, a: 'x', b: 'old' });
      expect(await s.putIf({ rev: 2, a: 'y' }, { rev: 1 })).toBe(true);
      const got = await s.get();
      expect(got).toEqual({ rev: 2, a: 'y' });
      // put と同じ置換意味論（渡さなかったキーは残らない）。
      expect(Object.keys(got ?? {})).not.toContain('b');
    });

    it.each([
      ['版が違う', { rev: 2 }],
      ['版が無いことを期待したのに在る', { rev: undefined }],
    ] as const)('🔴 %s なら書かず、記録は変わらない', async (_l, expected) => {
      const s = handle();
      await s.put({ rev: 1, a: 'x', b: 'keep' });
      expect(await s.putIf({ rev: 9, a: 'lost' }, expected)).toBe(false);
      expect(await s.get()).toEqual({ rev: 1, a: 'x', b: 'keep' });
    });

    it('🔴 版を持たない旧レコードは「版が無い」として扱う', async () => {
      const s = handle();
      await s.put({ a: 'legacy' });
      expect(await s.putIf({ rev: 5, a: 'no' }, { rev: 1 })).toBe(false);
      expect(await s.get()).toEqual({ a: 'legacy' });
      expect(await s.putIf({ rev: 1, a: 'yes' }, { rev: undefined })).toBe(true);
      expect(await s.get()).toEqual({ rev: 1, a: 'yes' });
    });

    /**
     * 🔴 **同じ版を読んだ 2 つの書き手のうち、勝つのは 1 つだけ。** lost update の本体。
     * 片方が無言で上書きされるなら、この性質が無いのと同じである。
     */
    it('🔴 同じ版を期待した 2 つの書き込みは 1 つしか通らない', async () => {
      const s = handle();
      await s.put({ rev: 1, a: 'base' });
      const results = await Promise.all([
        s.putIf({ rev: 2, a: 'first' }, { rev: 1 }),
        s.putIf({ rev: 2, a: 'second' }, { rev: 1 }),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = results[0] ? 'first' : 'second';
      expect(await s.get()).toEqual({ rev: 2, a: winner });
    });

    it('条件の無い putIf は呼び出しの誤りとして拒否し、書かない', async () => {
      const s = handle();
      await s.put({ rev: 1, a: 'x' });
      await expect(s.putIf({ rev: 2, a: 'y' }, {})).rejects.toThrow(/expected/);
      expect(await s.get()).toEqual({ rev: 1, a: 'x' });
    });
  });
}
