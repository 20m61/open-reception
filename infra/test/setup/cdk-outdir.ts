/**
 * CDK の synth 出力を周回ごとの一時 root へ閉じ込め、終了時に丸ごと消す (#721)。
 *
 * ## なぜ要るか
 *
 * `new cdk.App()` を `outdir` 無しで作ると、CDK は `os.tmpdir()` 配下に
 * `cdk.outXXXXXX` を `mkdtemp` して**消さない**。infra テストは App を多数作るので、
 * 1 回の実行で数十個が残る。`.open-next` が fresh のとき走る WebStack 系は
 * 78MB のバンドルを asset としてコピーするため、**1 個あたり約 98MB** になる。
 *
 * 2026-08-19、同一クラウドセッションで `--full` を 8 回ほど回したところ
 * `/tmp/cdk.out*` が **740 個・26GB** に達してディスクが 100% になり、**e2e が落ちた**。
 * 症状は `page.screenshot: Target crashed` と SSL ハンドシェイク失敗で、
 * **変更内容を疑う方向へ誘導される**（メモリも load も正常だった）。
 *
 * ## なぜ TMPDIR なのか
 *
 * - `CDK_OUTDIR` は**単一の値**なので、全 App が同じ outdir を共有してしまう。
 *   実測すると manifest 等が上書きし合って**テストが 5 件落ちる**
 * - `new cdk.App({ outdir })` を各テストに書くのは 11 ファイル・数十箇所に散る
 *
 * `os.tmpdir()` は `TMPDIR` を見るので、ここを向け替えれば **App ごとの一意な
 * `mkdtemp` はそのまま**に、出力先だけを 1 つの root 配下へ集められる。
 * 後始末は root を 1 つ消すだけで済む。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** この root 配下に落ちたことが分かる印。テストからも検証する。 */
export const CDK_TMP_PREFIX = 'open-reception-cdk-';

export function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), CDK_TMP_PREFIX));
  // ワーカープロセスは globalSetup の後に fork され、この env を継承する。
  process.env.TMPDIR = root;
  return () => {
    rmSync(root, { recursive: true, force: true });
  };
}
