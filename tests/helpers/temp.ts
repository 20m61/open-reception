/**
 * テストが作る一時領域を、**テストごとに必ず回収する**小道具 (#1136)。
 *
 * ## なぜ要るか
 *
 * 2026-09-17 の実測で `/tmp` に **18,726 エントリ**が積もっており、そのうち
 * **10,317 件**が `tests/hooks/aws-preflight.test.ts` / `aws-diff-gate.test.ts` の
 * 作る JSON だった。ディスクは 22G 空いていたのに、`tests/config/capability-doc-sync.test.ts` が
 * `Test timed out in 5000ms`（実測 8751ms）で落ちた —— **単独実行では 663ms / 16 passed**。
 * 掃除したら green になった。
 *
 * 🔴 **`CLAUDE.md` が #721 で名指ししている型と同じ**である ——
 * 「メモリも load も正常なまま赤くなる」ので、**コードを疑う方向へ時間を溶かす**。
 *
 * ## 回収は 2 段（隔離が下、helper が上）
 *
 * 🔴 **リークの防壁は `tests/setup/temp-isolation.ts`** である ——
 * テストファイルごとに `TMPDIR` を切るので、**どの綴りで作られたものも**
 * ファイル終了時に root ごと消える。この helper は「テストごとに小さく保つ」ための
 * 作法であって、**リークを防ぐ機構ではない**（走査で綴りを数え上げる方式を
 * 撤回したときに、役割がこうなった）。
 *
 * ## なぜ `finally` ではないか
 *
 * 🔴 **当初ここに「timeout で `SIGTERM` を受けると `finally` は走らない」と書いたが、
 * vitest では誤りだった**（レビュー 1 周目の指摘を受けて実測 ——
 * per-test timeout で落ちても `finally` は走る）。`.claude/rules/opus5-autonomous-loop.md`
 * の教訓は**サブエージェントのプロセスが SIGTERM を受けた**話で、射程を取り違えていた。
 *
 * 実測できる理由だけを書く:
 *
 * 1. 呼び出し側が後始末を**書き忘れられない**（これが主目的）
 * 2. ヘルパ関数の中で作ったパスにも効く（`fakeEnv()` のような形で作ると、
 *    呼び出し側は何を作ったか知らない）
 * 3. `finally` へ到達する前に throw / 早期 return しても回収される
 * 4. 🔴 **run 全体が kill されたときは `finally` も `afterEach` も走らない** ——
 *    元の教訓の正しい射程はここ。どちらを選んでも防げないので、
 *    ゲートの「一時領域」節が件数を出して気づかせる側で受ける
 *
 * ## 使い方
 *
 * ```ts
 * import { makeTempDir, makeTempFile } from '../helpers/temp';
 * const dir = makeTempDir('gate-stamp-');            // it の中で使う
 * const shared = makeSharedTempDir('gate-guard-');   // beforeAll で作って共有する
 * const path = makeTempFile('aws-preflight-test-', JSON.stringify(value));
 * ```
 *
 * 呼び出し側は**後始末を書かない**。書き忘れが起こりえない形にするのが目的である。
 *
 * 🔴 **`src` のテストもここを import する**（`src/domain/governance/merge-scan-ref.test.ts`）。
 * `src` → `tests` の依存は今回が初だが、**テストからテストヘルパへの依存**なので
 * 層としては問題ない（本番コードはこのモジュールを import しない ——
 * `import { afterEach } from 'vitest'` を持つので、そもそもできない）。
 *
 * 🔴 **`test.concurrent` / `describe.concurrent` とは併用できない**（`afterEach` の
 * per-test 回収が、同一ファイル内で並行する別テストのパスを消しうる）。
 * 今日このリポジトリに `concurrent` は 1 つも無い（走査で確認）。使うときはここを見直すこと。
 */
import { afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 🔴 **回収の範囲は、作った範囲と一致させる（移行中に実測で踏んだ）。**
 *
 * 最初は `afterEach` の 1 本だけを持っていた。ところが `beforeAll` で作って
 * 複数の `it` で共有しているテストが**実在し**（`pr-gate-guard-mcp.test.ts` /
 * `aws-cloud-deploy.test.ts`）、1 本目の `it` の後にディレクトリが消えて
 * **4 件が落ちた**。範囲を選ばせるのが正しい ——
 * 選び間違えたら**テストが落ちる**（沈黙のリークにはならない）。
 */
const perTest: string[] = [];

const drain = (paths: string[]): void => {
  // 🔴 **1 件が throw しても残りを必ず試す（レビュー 1 周目 MINOR 7）。**
  // `splice(0)` で先に全部取り出すので、途中で throw すると**残りが registry から
  // 消えたまま回収されない**（stub スクリプトが作る実行属性つきツリーで EACCES/EBUSY はありえる）。
  for (const path of paths.splice(0)) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // 回収できなかったものは諦める。ここで throw するとテスト全体が赤くなり、
      // **本来の失敗が読めなくなる** —— 残骸はゲートの「一時領域」節が件数で拾う。
    }
  }
};

// 🔴 **import した時点で登録されるので、呼び出し側が後始末を書き忘れても回収される。**
//    （`finally` を避ける理由は上の doc の 1〜3。「timeout で finally が走らない」ではない）
afterEach(() => drain(perTest));

/** 1 つの `it` の中だけで使う一時ディレクトリ。`afterEach` で回収する。 */
export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  perTest.push(dir);
  return dir;
}

/**
 * `beforeAll` で作って複数の `it` で共有する一時ディレクトリ。
 * 🔴 `makeTempDir` を `beforeAll` で使うと 1 本目の `it` の後に消える（実測）。
 *
 * 🔴 **登録しない（撤回。2026-09-17）。** 以前は `perFile` へ積んで `afterAll` で
 * 回収していたが、一時領域が**ファイル単位で隔離**されるようになったので
 * （`tests/setup/temp-isolation.ts`）、ファイル終了時に root ごと消える ——
 * つまりこの登録が守るものは無くなった。実測でも `perFile.push` を落とす変異が
 * **生存した**（残骸は隔離が回収するので実害が無い）。
 * **守るものが無い機構は置かない**（`.claude/rules/opus5-autonomous-loop.md`）。
 *
 * 残る違いは寿命だけである: `makeTempDir` は**テストごと**、こちらは**ファイルごと**。
 */
export function makeSharedTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 一時ファイルを作る。回収は自動。 */
export function makeTempFile(prefix: string, contents: string, extension = '.json'): string {
  const path = join(makeTempDir(prefix), `value${extension}`);
  writeFileSync(path, contents);
  return path;
}

/**
 * 🔴 **`registerTempPath`（自前で作ったパスを回収対象へ足す逃げ道）は撤回した
 * （レビュー 1 周目 MINOR 4）。** 消費者がゼロで、「使ったら理由を書くこと」という
 * 運用規約つきの公開 API が使われないまま残っていた ——
 * 守るものが無い機構は置かない（`.claude/rules/opus5-autonomous-loop.md`）。
 *
 * 作らずに参照するだけの正当な逸脱は、**検出器の行マーカー**（`// temp-ok: <理由>`）で抜く。
 */
