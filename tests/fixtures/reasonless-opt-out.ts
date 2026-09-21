/**
 * 🔴 **走査の下界（#1136 / 実測 T15）。** 逸脱マーカーに**理由を書かない**形。
 *
 * `// temp-ok:` は隔離を迂回する行を通す唯一の抜け道なので、**理由が必須**である。
 * 理由を必須にする `\S` を外す変異が**生存した**（縛るものが無かった）ので、
 * 「理由なしのマーカーは通らない」ことをこの fixture で固定する。
 *
 * 🔴 **実行されない。**
 */
import { writeFileSync } from 'node:fs';

/** 理由なしのマーカーで隔離を迂回しようとする（走査に見つかるためだけに在る）。 */
export function optsOutWithoutReason(): string {
  // temp-ok:
  const path = '/tmp/reasonless-opt-out.json';
  writeFileSync(path, '{}');
  return path;
}
