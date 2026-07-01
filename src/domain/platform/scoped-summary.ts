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
 * 契約: tie-break は **rank の値**で行う。`rankOf` は列挙値に対して**単射**（値⇔rank が一意）である
 * 前提で、現行の SEVERITY_RANK / LEVEL_RANK / STATE_RANK はいずれも単射。異なる列挙値が同一 rank を
 * 共有する（非単射）場合、それらは rank 同点として **time 降順**で並ぶ（＝優先度が同じなら新しい順）。
 * 元の各実装（`a.severity !== b.severity` 等の列挙不等で分岐）と単射マップ下では完全に同一挙動になる。
 *
 * @param flagOf 対応が要る（active/pending）か。true を前に並べる。
 * @param rankOf 重み（大きいほど注意）。降順に並べる。単射前提（上記契約）。
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
