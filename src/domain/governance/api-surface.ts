/**
 * 公開 API 表面の差分判定 (issue #424「config / API schema の diff チェック」)。
 *
 * I/O を持たない純関数。ファイル走査とスナップショット比較は
 * `src/app/api/api-surface.test.ts`（fitness test）が行う。
 *
 * ## なぜ要るか
 *
 * `change-risk`（増分 3）は「公開 API に該当するパスを触った」ことは検出するが、**何が
 * 増えて何が消えたか**は見ない。実際に壊れるのは**削除と改名**で、しかも壊れる相手は
 * リポジトリの外に居る——**配布済みの受付端末**が `/api/kiosk/*` を叩き続けている。
 * 同一リポジトリ内の呼び出し元は typecheck が捕まえるが、現場の端末は捕まえない。
 *
 * ## 追加と削除を区別する
 *
 * 追加は非破壊、削除・改名は破壊的。区別せずに「スナップショットが違う」とだけ言うと、
 * 更新がすべて同じ重みになり**破壊的変更がレビューで埋もれる**。
 */

/** `"<METHOD> <path>"` 形式のエントリ（例: `GET /api/kiosk/flow`）。 */
export type ApiSurfaceEntry = string;

export type ApiSurfaceDiff = {
  /** 新しく生えたエントリ（非破壊）。 */
  added: readonly ApiSurfaceEntry[];
  /** 消えたエントリ（**破壊的**）。改名は removed + added の組で現れる。 */
  removed: readonly ApiSurfaceEntry[];
};

const sorted = (values: Iterable<ApiSurfaceEntry>): ApiSurfaceEntry[] =>
  [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * スナップショットと現状を突き合わせる。
 *
 * 集合として比較するので**走査順には依存しない**。結果はソート済みで、差分の出方が実行ごとに
 * 揺れない（揺れると「毎回何か出る」ので読まれなくなる）。
 */
export function diffApiSurface(
  previous: readonly ApiSurfaceEntry[],
  current: readonly ApiSurfaceEntry[],
): ApiSurfaceDiff {
  const before = new Set(previous);
  const after = new Set(current);
  return {
    added: sorted([...after].filter((entry) => !before.has(entry))),
    removed: sorted([...before].filter((entry) => !after.has(entry))),
  };
}

/** スナップショットの本文へ整形する（ソート済み・1 行 1 エントリ・末尾改行）。 */
export function formatApiSurface(entries: readonly ApiSurfaceEntry[]): string {
  return `${sorted(entries).join('\n')}\n`;
}

/**
 * スナップショット本文を読み戻す。
 *
 * 空行と `#` 始まりのコメント行は無視する（見出しや「なぜこの経路が在るか」の注記を
 * 同じファイルに置けるようにする。別ファイルへ分けると片方だけ腐る）。
 */
export function parseApiSurface(text: string): ApiSurfaceEntry[] {
  const entries: ApiSurfaceEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    entries.push(trimmed);
  }
  return entries;
}
