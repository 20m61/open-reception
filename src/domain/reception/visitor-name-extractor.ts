import type { ProposedValue } from './slot-proposal';

/**
 * 氏名を尋ねた直後の発話から氏名の候補を取り出す、規則による抽出器（#1290、日本語のみ）。
 *
 * 外へは何も送らない（LLM などの外部の抽出器は使わない）。ここが返すのは**候補と抽出器の
 * 確信度**だけで、氏名として使うかどうかは `resolveReceptionSlotProposal`（STT と抽出器の
 * 両方の下限・長さの上限。ADR 0011 §3-a・§3-e）が決め、確定は復唱への肯定だけが行う（§3-b）。
 *
 * PII: 発話も氏名も、ログ・計測へ渡さない（ADR 0011 §6）。
 */

/** 名乗りの定型を落とした後に残った値の確信度。 */
const CONFIDENCE_SELF_INTRODUCED = 0.9;
const CONFIDENCE_BARE = 0.8;
/** 名前ではなさそうな発話。`minProposalConfidence`（0.72）を必ず下回る値にする。 */
const CONFIDENCE_NOT_A_NAME = 0.3;

const FILLER = /^(?:えー*っと|ええと|えー+|あの[ーぉ]*|あー+|はい)[、,\s]*/u;
const SELF = /^(?:わたくし|わたし|私|僕|ぼく)(?:の名前)?(?:は|、|,)?\s*/u;
const NAME_IS = /^(?:お?名前は)\s*/u;
const SUFFIX = /\s*(?:と申します|といいます|と言います|でございます|です)$/u;
const EDGE_PUNCT = /^[\s。、．，.,!！?？]+|[\s。、．，.,!！?？]+$/gu;
/** 文を作る助詞・用件の語。これが残る発話は名乗りではない。 */
const NOT_A_NAME = /(?:に会い|会いに|来まし|予約|ありま|どこ|ですか|[?？]|さんに|様に|をお願い)/u;

export function extractVisitorName(transcript: string): ProposedValue<string> | undefined {
  let text = transcript.replace(EDGE_PUNCT, '');
  if (NOT_A_NAME.test(text)) {
    return text === '' ? undefined : { value: text, confidence: CONFIDENCE_NOT_A_NAME };
  }
  let introduced = false;
  for (const pattern of [FILLER, SELF, NAME_IS]) {
    const next = text.replace(pattern, '');
    if (next !== text) {
      if (pattern !== FILLER) introduced = true;
      text = next;
    }
  }
  const withoutSuffix = text.replace(SUFFIX, '');
  if (withoutSuffix !== text) introduced = true;
  const value = withoutSuffix.replace(EDGE_PUNCT, '');
  if (value === '') return undefined;
  return { value, confidence: introduced ? CONFIDENCE_SELF_INTRODUCED : CONFIDENCE_BARE };
}

export type ReadbackAnswer = 'yes' | 'no' | 'unknown';

const NEGATIVE = /(?:いいえ|いや|違|ちが|じゃない|ではない|^no\b)/iu;
const AFFIRMATIVE = /^(?:はい|ええ|そうです|そう|お願いします|おねがいします|合って|あって|大丈夫|yes\b)/iu;

/**
 * 復唱への答えを「はい／いいえ／どちらでもない」に分ける。否定の語が 1 つでも混ざれば
 * 「はい」とみなさない（「はい、違います」）。STT の確信度の下限は呼び出し側が先に見る（§3-b）。
 */
export function classifyReadbackAnswer(text: string): ReadbackAnswer {
  const normalized = text.normalize('NFKC').replace(EDGE_PUNCT, '');
  if (normalized === '') return 'unknown';
  if (NEGATIVE.test(normalized)) return 'no';
  if (AFFIRMATIVE.test(normalized)) return 'yes';
  return 'unknown';
}
