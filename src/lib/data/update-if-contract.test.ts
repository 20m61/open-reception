/**
 * `updateIf` のマージ意味論を **memory と dynamo の両方** で固定する契約テスト (#796)。
 *
 * ## なぜ要るか
 *
 * `updateIf` は `put` と違って**アイテム全体を置換しない**。`changes` に**書かなかったキーは
 * 旧値が残る**。#795 でこれを踏んだ ── 任意フィールドを空にして保存したのに旧値が残り、
 * **営業時間外画面が廃止した緊急連絡先を来訪者に出し続けた**（API は「消えた」と答えるのに）。
 *
 * 症状が出るのは**任意フィールドを消したときだけ**なので、通常の更新テストでは出ない。
 * だから「消す」側を明示的に縛る。
 *
 * ## 両バックエンドで同じ表を通す理由
 *
 * memory は `{ ...cur, ...changes }`、dynamo は `SET` / `REMOVE` と**実装がまったく別**で、
 * 「省略」と「明示 undefined」の扱いが**片方だけ変わっても本番まで気づけない**。
 * ローカル開発は memory、本番は dynamo なので、ずれると**本番だけが壊れる**。
 */
import { describe, it, expect } from 'vitest';
import { MemoryBackend } from './memory';
import { makeDynamoBackend } from './fake-dynamo';
import type { DataBackend } from './backend';

type Rec = { id: string; name: string; note?: string; version: number };

const BACKENDS: Array<[string, () => DataBackend]> = [
  ['memory', () => new MemoryBackend()],
  ['dynamo', () => makeDynamoBackend().backend],
];

for (const [label, make] of BACKENDS) {
  describe(`updateIf のマージ意味論 (${label})`, () => {
    async function seeded() {
      const col = make().collection<Rec>('department');
      await col.put({ id: 'd1', name: 'A', note: '旧メモ', version: 1 });
      return col;
    }

    it('changes に書かなかったキーは旧値が残る（置換ではない）', async () => {
      const col = await seeded();
      expect(await col.updateIf('d1', { name: 'B', version: 2 }, { version: 1 })).toBe(true);
      // note を渡していないので残る。これが #795 で踏んだ罠そのもの。
      expect(await col.get('d1')).toMatchObject({ name: 'B', note: '旧メモ', version: 2 });
    });

    /**
     * 🔴 **レコード全体を渡す呼び出し元が頼る性質。** 任意フィールドを空にしたいなら
     * **`undefined` を明示する**しかない。省略では消えない（上のテスト）。
     */
    it('changes に undefined を明示したキーは消える', async () => {
      const col = await seeded();
      expect(
        await col.updateIf('d1', { name: 'B', note: undefined, version: 2 }, { version: 1 }),
      ).toBe(true);
      const got = await col.get('d1');
      expect(got?.note).toBeUndefined();
      // 「値が undefined」ではなく「キーが無い」ことまで縛る。JSON 化や `in` 判定で差が出る。
      expect(Object.keys(got ?? {})).not.toContain('note');
      expect(got).toMatchObject({ name: 'B', version: 2 });
    });

    it('expected が現在値と食い違えば何も書かずに false', async () => {
      const col = await seeded();
      expect(await col.updateIf('d1', { name: 'B', note: undefined }, { version: 99 })).toBe(false);
      // 🔴 **下界も縛る。** 「false を返す」だけなら、常に false を返す実装で満たせる。
      expect(await col.get('d1')).toMatchObject({ name: 'A', note: '旧メモ', version: 1 });
    });

    it('対象が存在しなければ作成せず false', async () => {
      const col = await seeded();
      expect(await col.updateIf('missing', { name: 'X' }, {})).toBe(false);
      expect(await col.get('missing')).toBeUndefined();
    });
  });
}
