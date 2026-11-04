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
/**
 * 文を作る助詞・用件の語、名乗りでない決まり文句。これが残る発話は名乗りではない。
 * 決まり文句には、端末自身の促し（「お話しください」）がマイクへ回り込んだ形も含める (#1290)。
 */
const NOT_A_NAME =
  /(?:に会い|会いに|来まし|予約|ありま|どこ|ですか|[?？]|さんに|様に|をお願い|す[みい]ません|ちょっと|待って|もう一度|もういちど|ください|わかりません|分かりません|聞こえ)/u;

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

/**
 * 丁寧な否定（「〜ではありません」「合っていません」）も含める。肯定の語で始まっても否定を優先する。
 * 🔴 「ません」だけでは否定にしない —— 「問題ありません」「構いません」「すみません」は肯定や前置き (#1296)。
 */
const NEGATIVE = /(?:いいえ|いや|違|ちが|(?:では|じゃ|でも)(?:ない|ありません)|(?:合って|あって)い?(?:ない|ません)|^no\b)/iu;

/**
 * 🔴 **肯定は許可の列挙で決める（数え上げない）** (#1296)。答え全体が、決まった肯定の句と前置きだけで
 * できているときに限って「はい」とする。迷い・問い返し（「そうかなあ」「そうですかー」「そうだっけ」）や
 * 過去の否定（「合ってなかった」）を禁止として数え上げると、語尾を 1 文字伸ばすだけで抜け、違う氏名を
 * 確定する向きに倒れる。列挙に無い答えは「どちらでもない」で退ける（言い直しを 1 回使うだけの安全な向き）。
 */
const YES_PHRASE =
  'はい|ええ|うん|そう(?:です|ですね|ですよ|ですよね)?|その(?:とおり|通り)(?:です)?|確かに|(?:合って|あって)い?ます|大丈夫(?:です)?|問題(?:ありません|ない(?:です)?)|構いません|かまいません|お願いします|おねがいします|正しいです|yes|ok|okay';
/** 肯定の前後に添えるだけの語。これだけでは肯定にならない。 */
const FILLER_PHRASE = 'すみません|すいません|申し訳ありません|えっと|えーと|あの';
const SEPARATOR = '[\\s。、．，.,!！?？]*';
const ONLY_AFFIRMATIVE = new RegExp(`^(?:(?:${YES_PHRASE}|${FILLER_PHRASE})${SEPARATOR})+$`, 'iu');
const HAS_AFFIRMATIVE = new RegExp(`(?:${YES_PHRASE})`, 'iu');

/**
 * 復唱への答えを「はい／いいえ／どちらでもない」に分ける。否定の語が 1 つでも混ざれば
 * 「はい」とみなさない（「はい、違います」）。STT の確信度の下限は呼び出し側が先に見る（§3-b）。
 */
export function classifyReadbackAnswer(text: string): ReadbackAnswer {
  const normalized = text.normalize('NFKC').replace(EDGE_PUNCT, '');
  if (normalized === '') return 'unknown';
  if (NEGATIVE.test(normalized)) return 'no';
  if (ONLY_AFFIRMATIVE.test(normalized) && HAS_AFFIRMATIVE.test(normalized)) return 'yes';
  return 'unknown';
}
