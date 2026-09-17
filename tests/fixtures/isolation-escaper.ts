/**
 * 🔴 **走査の下界（#1136 / レビュー 2 周目）。** 隔離を**自分で上書きして**迂回する形。
 *
 * `tests/setup/temp-isolation.ts` はテストファイルごとに `process.env.TMPDIR` を
 * 専用 root へ向ける。テストがそれを**書き換えてしまう**と、以降の
 * `os.tmpdir()` は隔離の外を指す ―― 綴りに依らない隔離の、唯一の抜け道である。
 *
 * 子プロセスへ `env: { ...process.env, TMPDIR: x }` として**渡す**のは別物で、
 * 自分の `process.env` は書き換えないので走査には当たらない（実際に 2 箇所で使っている）。
 *
 * 🔴 **実行されない。**
 */
import { homedir, tmpdir } from 'node:os';

/** 隔離を自分で外す（走査に見つかるためだけに在る）。 */
export function escapesIsolation(): string {
  process.env.TMPDIR = homedir();
  return tmpdir();
}
