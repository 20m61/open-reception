/**
 * 来訪者氏名の自由発話認識境界 (#1057)。
 *
 * 担当者検索用 `SttAdapterFactory` は「既知の担当者名 phrases を与えて候補を得る」用途に
 * 最適化されている。一方、来訪者氏名は事前に列挙できない自由発話なので、その factory を
 * 空配列で流用しない。UI はこの中立境界だけを知り、Amazon Transcribe Streaming 等の
 * provider / transport 詳細は後続 adapter に閉じ込める。
 *
 * 認識結果は確定値ではなく候補。UI が必ず明示確認を挟んでから VisitorInfo へ保存する。
 */
export interface VisitorNameRecognizer {
  recognize(): Promise<readonly string[]>;
}

export type VisitorNameRecognizerFactory = () => VisitorNameRecognizer;

const DEFAULT_MAX_CANDIDATES = 4;

/**
 * provider が返した氏名候補を表示用に正規化する。
 *
 * - trim
 * - 空文字除外
 * - 同一表記を dedupe
 * - 判断対象を増やしすぎないよう最大4件
 *
 * ここでは氏名らしさの推測や敬称除去をしない。誤った自動整形より、来訪者の明示確認を優先する。
 * transcript / 候補はログへ送らないこと。
 */
export function normalizeVisitorNameCandidates(
  values: readonly string[],
  maxCandidates = DEFAULT_MAX_CANDIDATES,
): string[] {
  if (maxCandidates <= 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    const candidate = value.trim();
    if (candidate === '' || seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
    if (out.length >= maxCandidates) break;
  }
  return out;
}
