/**
 * プラットフォーム横断 read 集計で共有する並べ替え契約 (issue #251 / #83)。
 *
 * incident / update-status / notice は「**対応が要るものを先頭 → 重み(rank)降順 → 時刻の新しい順**」で
 * 並べる同一の順序契約を持つ。この比較子を1箇所に集約し、各モジュールで手書き複製しない
 * （契約変更が全箇所へ確実に反映される）。射影(whitelist)・集計(byX)・summary の形は各モジュールで
 * 正当に異なるため共通化しない。maintenance-window は開始予定の昇順という別契約のため対象外。
 */

/**
 * 「flag(true 優先) → rank 降順 → time 降順」の比較子を組み立てる純関数。
 *
 * @param flagOf 対応が要る（active/pending）か。true を前に並べる。
 * @param rankOf 重み（大きいほど注意）。降順に並べる。
 * @param timeOf 比較に使う ISO 時刻。新しい（辞書順で大きい）ものを前に並べる。
 */
export function byFlagRankTimeDesc<T>(opts: {
  flagOf: (row: T) => boolean;
  rankOf: (row: T) => number;
  timeOf: (row: T) => string;
}): (a: T, b: T) => number {
  return (a, b) => {
    const fa = opts.flagOf(a);
    const fb = opts.flagOf(b);
    if (fa !== fb) return fa ? -1 : 1;
    const ra = opts.rankOf(a);
    const rb = opts.rankOf(b);
    if (ra !== rb) return rb - ra;
    return opts.timeOf(b).localeCompare(opts.timeOf(a));
  };
}
