import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * `.open-next/` 成果物の状態を 3 値で表す (#628)。
 *
 * ## なぜ absent と stale を分けるのか
 *
 * `WebStack` の synth はこの 2 つを**どちらも例外**にする（デプロイ直前のガードとしては
 * 正しい。stale をデプロイして 2026-08-04 にセキュリティ修正 4 件を落とした実績がある）。
 * しかし**テストとゲート**では意味が違う:
 *
 * - `absent` … まだ 1 度もビルドしていない。CDK テストは実行不能。
 * - `stale`  … ビルド済みだが `src/` の方が新しい。**`src` を触れば毎回こうなる**ので、
 *   これを赤にするとゲートが常時赤になり「赤を無視する習慣」がつく（#424 増分 3 と同じ理屈）。
 * - `fresh`  … 実行可能。
 *
 * よってテスト側は `fresh` のときだけ synth し、それ以外は**理由付きで**スキップする。
 * 黙って 0 件にしないことが #628 の要点。
 */
export type ArtifactState = 'fresh' | 'stale' | 'absent';

export interface ArtifactStatus {
  readonly state: ArtifactState;
  /** `absent` のとき、`.open-next/` からの相対パスで欠けているもの。 */
  readonly missing: readonly string[];
  /** `open-next.output.json` の mtime（ミリ秒）。`absent` なら undefined。 */
  readonly artifactMtime?: number;
  /** `src/` 配下で最も新しい mtime（ミリ秒）。src が空なら undefined。 */
  readonly newestSrcMtime?: number;
}

/** synth に必要な成果物（`.open-next/` からの相対パス）。 */
const REQUIRED = [
  'open-next.output.json',
  'assets',
  path.join('server-functions', 'default', 'index.mjs'),
  path.join('image-optimization-function', 'index.mjs'),
];

/** `repoRoot` の `.open-next/` を検査する。副作用なし。 */
export function openNextArtifactState(repoRoot: string): ArtifactStatus {
  const dir = path.join(repoRoot, '.open-next');
  const missing = REQUIRED.filter((rel) => !fs.existsSync(path.join(dir, rel)));
  if (missing.length > 0) return { state: 'absent', missing };

  const artifactMtime = fs.statSync(path.join(dir, 'open-next.output.json')).mtimeMs;
  const newestSrcMtime = newestMtimeUnder(path.join(repoRoot, 'src'));

  // src が空/不在なら比較対象が無い。「分からない」を stale へ倒すと、src を持たない
  // チェックアウトで永久にスキップし続けることになるので fresh とする。
  if (newestSrcMtime === undefined || newestSrcMtime <= artifactMtime) {
    return { state: 'fresh', missing: [], artifactMtime, newestSrcMtime };
  }
  return { state: 'stale', missing: [], artifactMtime, newestSrcMtime };
}

/**
 * スキップ理由を人間向けに 1 行で返す。`fresh` は空文字。
 *
 * 「未ビルドなのでスキップしました」だけでは直せないので、**何が欠けているか / どれくらい
 * 古いか**と復旧コマンドまで出す。
 */
export function describeArtifactState(status: ArtifactStatus): string {
  const build = 'npm run build:open-next';
  if (status.state === 'fresh') return '';
  if (status.state === 'absent') {
    return `.open-next/ が未ビルド（不足: ${status.missing.join(', ')}）— \`${build}\` で作成`;
  }
  const artifact = new Date(status.artifactMtime!).toISOString();
  const src = new Date(status.newestSrcMtime!).toISOString();
  return `.open-next/ が src/ より古い（.open-next: ${artifact} / newest src: ${src}）— \`${build}\` で更新`;
}

/** `dir` 配下で最も新しいファイルの mtime（ミリ秒）。見つからなければ undefined。 */
export function newestMtimeUnder(dir: string): number | undefined {
  if (!fs.existsSync(dir)) return undefined;
  let newest: number | undefined;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const stat = fs.statSync(path.join(entry.parentPath ?? dir, entry.name));
    if (newest === undefined || stat.mtimeMs > newest) newest = stat.mtimeMs;
  }
  return newest;
}
