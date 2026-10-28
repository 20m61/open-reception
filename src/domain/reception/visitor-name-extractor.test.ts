import { describe, expect, it } from 'vitest';
import { DEFAULT_SLOT_PROPOSAL_RESOLUTION_POLICY } from './slot-proposal';
import { classifyReadbackAnswer, extractVisitorName } from './visitor-name-extractor';

/**
 * 氏名を尋ねた直後の発話から、氏名の候補を取り出す（#1290）。合成データだけを使う。
 *
 * 取り出した値は `resolveReceptionSlotProposal` の下限（STT・抽出器の確信度、長さ）を通ってから
 * 復唱に出る。ここで縛るのは「名乗りの定型を落として名前だけを残す」ことと、「名前ではなさそうな
 * 発話を、下限を越える確信度で返さない」こと。
 */
const FLOOR = DEFAULT_SLOT_PROPOSAL_RESOLUTION_POLICY.minProposalConfidence;

describe('extractVisitorName', () => {
  it.each([
    ['受付 太郎です', '受付 太郎'],
    ['受付太郎と申します', '受付太郎'],
    ['受付といいます。', '受付'],
    ['受付と言います', '受付'],
    ['受付でございます', '受付'],
    ['えっと、受付 太郎です', '受付 太郎'],
    ['あの、受付です', '受付'],
    ['はい、受付です', '受付'],
    ['私は受付です', '受付'],
    ['わたくし、受付と申します', '受付'],
    ['名前は受付です', '受付'],
    ['受付 太郎', '受付 太郎'],
    ['Taro Uketsuke', 'Taro Uketsuke'],
  ])('「%s」→「%s」（下限以上の確信度）', (transcript, name) => {
    const proposal = extractVisitorName(transcript);
    expect(proposal?.value).toBe(name);
    expect(proposal?.confidence).toBeGreaterThanOrEqual(FLOOR);
  });

  it.each(['田中さんに会いに来ました', '会議の予約があります', '受付はどこですか？', 'トイレはどこ'])(
    '名前ではなさそうな発話「%s」は下限を越えない',
    (transcript) => {
      const proposal = extractVisitorName(transcript);
      expect(proposal === undefined || proposal.confidence < FLOOR).toBe(true);
    },
  );

  it.each(['', '   ', 'です', 'えっと', '。'])('名前が残らない発話「%s」は候補にしない', (transcript) => {
    expect(extractVisitorName(transcript)).toBeUndefined();
  });
});

describe('classifyReadbackAnswer', () => {
  it.each(['はい', 'はい。', 'ええ', 'そうです', 'はい、そうです', 'お願いします', '合ってます', 'yes', 'Yes'])(
    '「%s」は yes',
    (text) => {
      expect(classifyReadbackAnswer(text)).toBe('yes');
    },
  );

  it.each(['いいえ', 'いや', '違います', 'ちがう', 'はい、違います', 'そうじゃないです', 'no', 'No'])(
    '「%s」は no（否定が混ざれば yes にしない）',
    (text) => {
      expect(classifyReadbackAnswer(text)).toBe('no');
    },
  );

  it.each(['', 'えっと', '受付です', 'もう一度'])('「%s」はどちらでもない', (text) => {
    expect(classifyReadbackAnswer(text)).toBe('unknown');
  });
});
