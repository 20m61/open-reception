/**
 * 来訪者氏名の自由発話認識境界 (#1057 / #1077)。
 *
 * 担当者検索用 `SttAdapterFactory` は「既知の担当者名 phrases を与えて候補を得る」用途に
 * 最適化されている。一方、来訪者氏名は事前に列挙できない自由発話なので、その factory を
 * 空配列で流用しない。UI はこの中立境界だけを知り、Amazon Transcribe Streaming 等の
 * provider / transport 詳細は後続 adapter に閉じ込める。
 *
 * provider 固有の confidence 数値を UI へ直接漏らさず、adapter 側で product-level の
 * `high / low` へ正規化する。これにより確認ポリシーを provider から独立させる。
 */
export type VisitorNameCertainty = 'high' | 'low';

export type VisitorNameCandidate = {
  text: string;
  certainty: VisitorNameCertainty;
};

export interface VisitorNameRecognizer {
  recognize(): Promise<readonly VisitorNameCandidate[]>;
}

export type VisitorNameRecognizerFactory = () => VisitorNameRecognizer;

const DEFAULT_MAX_CANDIDATES = 4;

/**
 * provider が返した氏名候補を表示用に正規化する。
 *
 * - trim
 * - 空文字除外
 * - 同一表記を dedupe
 * - 同じ表記が high / low の両方で来た場合は high を採用
 * - 判断対象を増やしすぎないよう最大4件
 *
 * ここでは氏名らしさの推測や敬称除去をしない。誤った自動整形をしない。
 * transcript / 候補はログへ送らないこと。
 */
export function normalizeVisitorNameCandidates(
  values: readonly VisitorNameCandidate[],
  maxCandidates = DEFAULT_MAX_CANDIDATES,
): VisitorNameCandidate[] {
  if (maxCandidates <= 0) return [];

  const byText = new Map<string, VisitorNameCandidate>();
  const order: string[] = [];

  for (const value of values) {
    const text = value.text.trim();
    if (text === '') continue;

    const existing = byText.get(text);
    if (!existing) {
      byText.set(text, { text, certainty: value.certainty });
      order.push(text);
    } else if (existing.certainty === 'low' && value.certainty === 'high') {
      byText.set(text, { text, certainty: 'high' });
    }

    if (order.length >= maxCandidates) break;
  }

  return order.map((text) => byText.get(text)!).filter(Boolean);
}

export type VisitorNameRecognitionDisposition =
  | { kind: 'error' }
  | { kind: 'accept'; candidate: VisitorNameCandidate }
  | { kind: 'confirm'; candidate: VisitorNameCandidate }
  | { kind: 'choose'; candidates: VisitorNameCandidate[] };

/**
 * #1077 Minimum-Turn の氏名確認ポリシー。
 *
 * - 1件 + high: 氏名だけの yes/no は挟まず、provisional として final confirmation へ進める。
 * - 1件 + low: short readback / yes-no でその slot だけ修復する。
 * - 複数: 候補ボタンで disambiguation。候補タップが明示選択なので、その後さらに氏名だけ
 *   yes/no を重ねない。
 * - 0件: retry / assistance。
 *
 * いずれも `CONFIRM` / call を実行するものではない。最終呼び出し確定は `confirming` の
 * 明示タッチに残す。
 */
export function visitorNameRecognitionDisposition(
  values: readonly VisitorNameCandidate[],
): VisitorNameRecognitionDisposition {
  const candidates = normalizeVisitorNameCandidates(values);
  if (candidates.length === 0) return { kind: 'error' };
  if (candidates.length > 1) return { kind: 'choose', candidates };

  const candidate = candidates[0]!;
  return candidate.certainty === 'high'
    ? { kind: 'accept', candidate }
    : { kind: 'confirm', candidate };
}
