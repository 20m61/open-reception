/**
 * `updateIf` の**本番呼び出し元を数える**トリップワイヤ (#796)。
 *
 * `updateIf` はマージなので、**レコード全体を渡す呼び出し元**は任意フィールドを
 * `undefined` で明示しないと「消したつもりが消えない」。#795 で実際に踏んだ。
 *
 * この型の危険は「`put` を `updateIf` に変えた瞬間」に生まれ、**通常の更新テストでは出ない**
 * （症状は任意フィールドを消したときだけ）。だから**呼び出し元が増えたこと自体を検出する**。
 * 増やすのは構わない ── ただし「レコード全体を渡していないか」を見てから、この表に足すこと。
 *
 * 縛っているのは意味論ではなく**注意の所在**である。意味論そのものは
 * `update-if-contract.test.ts` が memory / dynamo の両方で固定している。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 既知の呼び出し元と、レコード全体を渡すかどうか。 */
const KNOWN: Record<string, 'partial' | 'whole-record'> = {
  // 狭いフィールド集合だけを渡す（罠に当たらない）。
  'src/lib/tenant/data-repository.ts': 'partial',
  'src/lib/platform/repository.ts': 'partial',
  'src/lib/routing/call-correlation.ts': 'partial',
  'src/lib/data-stores/reception-repository.ts': 'partial',
  // レコード全体を渡す。**任意フィールドを `undefined` で明示している**ことが前提。
  'src/lib/runtime-policy/store.ts': 'whole-record',
  'src/lib/operating-policy/store.ts': 'whole-record',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('updateIf の本番呼び出し元 (#796)', () => {
  it('把握していない呼び出し元が増えていない', () => {
    const callers = walk('src')
      // backend 実装そのもの（定義側）は呼び出し元ではない。
      .filter((f) => !f.startsWith('src/lib/data/'))
      .filter((f) => /\.updateIf\(/.test(readFileSync(f, 'utf8')))
      .sort();
    expect(
      callers,
      'updateIf の呼び出し元が増減した。レコード全体を渡していないか（任意フィールドを ' +
        'undefined で明示しているか）を確かめてから KNOWN を更新すること',
    ).toEqual(Object.keys(KNOWN).sort());
  });
});
