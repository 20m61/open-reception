/**
 * 🔴 **走査の下界（#1136 / レビュー 2 周目）。** 隔離を**絶対パスで迂回する**形。
 *
 * 一時領域はテストファイルごとに `TMPDIR` を切って隔離してあるので、
 * `os.tmpdir()` 経由で作られたものは綴りに関係なく回収される
 * （`tests/setup/temp-isolation.ts`）。**塞がらないのは絶対パスの直書き**で、
 * この fixture がその面を代表する。
 *
 * 🔴 **実行されない。** 走査されるのは本文の綴りだけで、この関数は誰も呼ばない。
 */
import { writeFileSync } from 'node:fs';

/** 隔離を迂回して `/tmp` を直接書く（走査に見つかるためだけに在る）。 */
export function writesUnderHardCodedTmp(): string {
  const path = '/tmp/hard-coded-tmp-writer.json';
  writeFileSync(path, '{}');
  return path;
}
