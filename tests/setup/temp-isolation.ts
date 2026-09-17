/**
 * 一時領域を**テストファイルごとに隔離する** (#1136)。
 *
 * ## なぜソース走査をやめてここへ来たか
 *
 * 当初は「helper 経由でしか一時パスを作らせない」を**ソースの走査**で担保していた。
 * 呼び出しの綴り → import の綴り、と 2 度作り替えたが、レビュー 2 周目の実測で
 * **16 綴りのうち 10 が素通り**した（名前空間 import・`node:` 無し・**prettier が普通に
 * 生成する複数行 import**・`require`・動的 `import()`・re-export・`'/tmp/...'` 直書き）。
 * 綴りを足す対処は、このリポジトリが何度も撤回してきた「数え上げ」である。
 *
 * 🔴 **だから方式を裏返した。** `os.tmpdir()` は POSIX で `process.env.TMPDIR` を
 * **呼び出しのたびに読む**（実測）。テストファイルごとに専用の root を切って
 * `TMPDIR` をそこへ向ければ、**どの綴りで作られたものも**その root の中に落ちる。
 * ファイルが終われば root ごと消すので、**綴りを 1 つも数えずに族ごと塞がる**。
 *
 * 実測（2 ファイルの probe）: 各ファイルが別の root を見る（`f-AbNPnF` / `f-kKVbQY`）、
 * 実行後に root は空、`/tmp` 直下に増えるのは unit レーン全体で **1 エントリ**だけ。
 *
 * ## 残る面（ここで塞がらないもの）
 *
 * 1. `/tmp` を**絶対パスで直書き**する（`TMPDIR` を経由しない）
 * 2. テストが自分で `process.env.TMPDIR` を**上書きする**
 *
 * この 2 つだけを `tests/config/temp-cleanup-guard.test.ts` が静的に見る。
 * 走査が見張る面が 2 つに縮んだので、**綴りの数え上げは消えた**。
 *
 * 3. **run 全体が kill されたとき**は `afterAll` が走らないので root が残る。
 *    これは `finally` でも防げない（元の教訓の正しい射程）。下の掃き出しと、
 *    ゲートの「一時領域」節（`vitest root N 件`）で受ける。
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/** 隔離前の本物の一時領域（`TMPDIR` を書き換える前に採る）。 */
const REAL_TMP = tmpdir();

/** すべてのテストファイルの root を束ねる親。`/tmp` 直下はこの 1 エントリだけになる。 */
export const RUN_ROOT = join(REAL_TMP, 'open-reception-vitest');

/**
 * kill された run が残した root を掃く。
 *
 * 🔴 **age で判断する（#721 の infra テストと同じ理由）。** 走行中の別ワーカーや
 * 並列トラックの root を消してはいけないので、**6 時間より古いものだけ**を対象にする。
 * 掃除に失敗しても続ける（掃除はこのテストの目的ではない）。
 */
const SWEEP_AGE_MS = 6 * 60 * 60 * 1000;

function sweepStaleRoots(): void {
  try {
    for (const name of readdirSync(RUN_ROOT)) {
      const path = join(RUN_ROOT, name);
      try {
        if (Date.now() - statSync(path).mtimeMs > SWEEP_AGE_MS) {
          rmSync(path, { recursive: true, force: true });
        }
      } catch {
        // 別のワーカーが同時に消した等。次へ進む。
      }
    }
  } catch {
    // RUN_ROOT がまだ無い / 読めない。作成は下で行う。
  }
}

mkdirSync(RUN_ROOT, { recursive: true });
sweepStaleRoots();

/** このテストファイル専用の root。 */
const fileRoot = mkdtempSync(join(RUN_ROOT, 'f-'));
process.env.TMPDIR = fileRoot;

afterAll(() => {
  // 先に戻す（回収が失敗しても、後続が消えた root を指し続けないように）。
  process.env.TMPDIR = REAL_TMP;
  try {
    rmSync(fileRoot, { recursive: true, force: true });
  } catch {
    // 消せなかったものはゲートの「一時領域」節が件数で拾う。
  }
});
