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
 * 1. **絶対パスで直書き**する（`TMPDIR` を経由しない）
 *    → **同じプロセスの書き込みは実行時に見る (#1154)。** `write-guard.ts` が fs の書き込み
 *      API を包み、隔離の外枠・リポジトリ以外への書き込みを下の `afterAll` で落とす
 *      （綴りに依らない。比較の実測は `write-guard.ts` の doc）。
 *    → **子プロセスの直書き**は見えないので、`tests/config/temp-cleanup-guard.test.ts` の
 *      静的走査（`'/tmp/'` 綴り）とゲートの件数が受ける。逸脱は `// temp-ok: <理由>`
 * 2. テストが自分で `TMPDIR` を**上書きする**
 *    → **静的には見ない**（綴りを数えることになるため）。上の `afterAll` が
 *      `os.tmpdir() !== fileRoot` を実行時に見て、そのファイルで大声で落とす
 *
 * 3. **run 全体が kill されたとき**は `afterAll` が走らないので root が残る。
 *    これは `finally` でも防げない（元の教訓の正しい射程）。下の掃き出しと、
 *    ゲートの「一時領域」節（`vitest root N 件`）で受ける。
 */
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { installWriteGuard, RUN_ROOT_ENV, type WriteViolation } from './write-guard';

/** 隔離前の本物の一時領域（`TMPDIR` を書き換える前に採る）。 */
const REAL_TMP = tmpdir();

/**
 * すべてのテストファイルの root を束ねる親。`<tmp>` 直下はこの 1 エントリだけになる。
 *
 * 🔴 **名前を短くしてある（実測 2026-09-21）。** 隔離は一時パスを深くするので、
 * `tsx` のような**UNIX ドメインソケットを掘る道具**の余白を食う（`sun_path` は 108 バイト）。
 * 実測: TMPDIR が 95 文字の環境でフル unit を回すと、**main でも 29 テストが
 * `EADDRINUSE` で落ちる**（`<tmp>/tsx-0/<pid>.pipe` が既に上限付近のため）。
 * `open-reception-vitest/f-XXXXXX`（30 文字）だと同じ環境で **74 テスト**まで悪化した。
 * `or-vitest/XXXXXX`（17 文字）へ縮めて余白の消費を最小化する。
 * **症状はアサーション到達前の失敗**なので、偽の赤として読み間違えやすい面である。
 */
export const RUN_ROOT = join(REAL_TMP, 'or-vitest');

/**
 * kill された run が残した root を掃く。
 *
 * 🔴 **age で判断する（#721 の infra テストと同じ理由）。** 走行中の別ワーカーや
 * 並列トラックの root を消してはいけないので、**6 時間より古いものだけ**を対象にする。
 * 掃除に失敗しても続ける（掃除はこのテストの目的ではない）。
 */
export const SWEEP_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * 🔴 **clock を注入して外から縛れる形にする（レビュー 3 周目 MAJOR 1）。**
 *
 * 当初は引数なしで `Date.now()` を直に読んでいたため、**どのテストからも縛られていなかった**
 * —— 実測で `SWEEP_AGE_MS` を 0 にする変異が**生存**した（機構のテストは全 PASS）。
 * しかも退行の症状はアサーション失敗ではなく**ハング**（走行中の他ワーカーの root を
 * 消すので、`tests/hooks` が 54s → 900s の timeout で SIGTERM。レビューの実測）。
 * 偽の赤として最も読み違えやすい形なので、両側を縛れるようにする。
 *
 * 形は同じリポジトリの先行実装（`infra/test/setup/cdk-outdir.ts` の `sweepStaleRoots`）に
 * 揃えた —— あちらは `utimesSync` で古さを作って正・負の対照つきで縛られている。
 *
 * @returns 実際に消した root のパス（テストが「消した／消さなかった」を見るため）
 */
export function sweepStaleRoots(runRoot: string, now: number): ReadonlyArray<string> {
  const swept: string[] = [];
  let names: string[];
  try {
    names = readdirSync(runRoot);
  } catch {
    // runRoot がまだ無い / 読めない。作成は下で行う。
    return swept;
  }
  for (const name of names) {
    const path = join(runRoot, name);
    try {
      if (now - statSync(path).mtimeMs <= SWEEP_AGE_MS) continue;
      rmSync(path, { recursive: true, force: true });
      swept.push(path);
    } catch {
      // 別のワーカーが同時に消した等。次へ進む。
    }
  }
  return swept;
}

mkdirSync(RUN_ROOT, { recursive: true });
sweepStaleRoots(RUN_ROOT, Date.now());

/** このテストファイル専用の root（接頭辞なし＝`XXXXXX` の 6 文字だけ足す）。 */
const fileRoot = mkdtempSync(`${RUN_ROOT}/`);
process.env.TMPDIR = fileRoot;

/**
 * 隔離の外への書き込みを実行時に見る (#1154)。許可するのは**回収される場所**だけ。
 *
 * 🔴 **外枠は最も外側の run のものを使う。** 子 vitest（`temp-cleanup-guard.test.ts` の
 * probe）は親の root の中に自分の `or-vitest` を掘るので、自分の `RUN_ROOT` だけを許すと
 * **親が渡したパスへの書き込み**（`ISOLATION_PROBE_OUT`）を違反と数える（実測で 1 件の偽陽性）。
 * env で外枠を子へ継がせる。親の root は親の `afterAll` が回収する。
 *
 * リポジトリ（`process.cwd()`）は一時領域ではないので許す。外すと実測で
 * `tests/hooks/change-budget.test.ts` が落ちる（リポジトリ内へ書いて自分で消すテスト）。
 */
const outerRunRoot = (process.env[RUN_ROOT_ENV] ??= RUN_ROOT);
const writeViolations: WriteViolation[] = [];
installWriteGuard(
  [outerRunRoot, process.cwd()].flatMap((root) => {
    // macOS の `/var` は `/private/var` への symlink なので、実体のパスでも許す。
    try {
      return [root, realpathSync(root)];
    } catch {
      return [root];
    }
  }),
  writeViolations,
);

function removeRoot(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // 消せなかったものはゲートの「一時領域」節が件数で拾う。
  }
}

afterAll(() => {
  // 🔴 **隔離が外れていないことを、綴りではなく実行時に見る（レビュー 3 周目 MAJOR 2）。**
  //
  // 以前は「`process.env.TMPDIR` への代入」をソース走査で見ていたが、それは**まだ綴りの
  // 数え上げ**で、`delete process.env.TMPDIR` / `process.env['TMPDIR'] =` /
  // `vi.stubEnv('TMPDIR', …)` / `Object.assign(process.env, …)` など **6 綴りが素通り**した
  // （レビューの実測）。走査の面を 1 つ撤回し、ここで**綴りに依らず**大声で落とす。
  //
  // 射程の限界（塞げないもの）: `process.env` を丸ごと差し替えた場合、`os.tmpdir()` は
  // C 側の環境を読むので隔離は維持され、この検査も通る（子プロセスへ渡る env からだけ
  // `TMPDIR` が落ちる）。実測済みで、今日そう書いているテストは 2 本ともスナップショットを
  // setup の後に採っているため無害。
  const actual = tmpdir();
  process.env.TMPDIR = REAL_TMP;
  removeRoot(fileRoot);
  if (actual !== fileRoot) {
    throw new Error(
      `一時領域の隔離が外れています（#1136）: os.tmpdir() が ${actual} を指しています。` +
        `期待は ${fileRoot} です。テストが process.env.TMPDIR を書き換えたなら、元へ戻してください`,
    );
  }
  if (writeViolations.length > 0) {
    const listed = [...new Set(writeViolations.map((v) => `  ${v.api} ${v.path}`))].join('\n');
    throw new Error(
      `一時領域の隔離の外へ書き込みました（#1154）:\n${listed}\n` +
        `一時ファイルは os.tmpdir() 経由で作ってください（${fileRoot} はファイル終了時に回収されます）`,
    );
  }
});

/**
 * 🔴 **`afterAll` は「全テストが skip されたファイル」では走らない（実測 2026-09-21）。**
 *
 * **収集時にエラーになったファイル**でも同じで（レビュー 3 周目 MINOR 3 の実測。TDD の
 * red 中は日常的に起きる）、その場合 root が**空のまま残る** ——
 * 「run ごとに 1 件」ではなく **「skip 全滅／収集失敗したファイルごとに 1 件」**である
 * （`src/lib/data/dynamodb.emulator.test.ts` が前者の実例）。
 *
 * 🔴 **`process.on('exit')` で塞ごうとしたが、撤回した** —— vitest のワーカーは
 * 正常終了ではなく終了させられるので、**ハンドラが発火しない**（実測。空の spec に
 * 張って marker を書かせたが書かれなかった）。**守れない機構は置かない。**
 *
 * 残骸は空ディレクトリだけで、上の掃き出し（6 時間）が上限を付け、
 * ゲートの「一時領域」節が `unit 隔離 root N 件` として**数えて見せる**。
 * ここを塞ぐには run ごとの root が要り、パスがさらに深くなる（上の `sun_path` の話と
 * 競合する）ので、**現状は「見える形で残す」を選ぶ**。
 */
