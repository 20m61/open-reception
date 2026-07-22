import { describe, expect, it } from 'vitest';

import { estimateSpokenText, truncateConversationHistory } from './history-truncation';

describe('estimateSpokenText', () => {
  it('経過時間の比率でテキストを按分する', () => {
    // 全体 1000ms、うち 500ms（50%）再生 → 10 文字中 5 文字。
    expect(estimateSpokenText('あいうえおかきくけこ', 0, 500, 1000)).toBe('あいうえお');
  });

  it('全体時間以上再生していれば全文', () => {
    expect(estimateSpokenText('こんにちは', 0, 5000, 1000)).toBe('こんにちは');
  });

  it('再生開始前後の負の経過は空文字', () => {
    expect(estimateSpokenText('こんにちは', 1000, 500, 1000)).toBe('');
  });

  it('全体時間が計測できない（0 以下）なら空文字（分母 0 を全文再生扱いにしない）', () => {
    expect(estimateSpokenText('こんにちは', 0, 500, 0)).toBe('');
    expect(estimateSpokenText('こんにちは', 0, 500, -10)).toBe('');
  });

  it('playbackStartMs を基準に経過を測る（絶対時刻 0 起点でなくてよい）', () => {
    expect(estimateSpokenText('あいうえお', 2000, 2400, 800)).toBe('あいう'); // 400/800=50% → 3文字(四捨五入)
  });
});

describe('truncateConversationHistory', () => {
  it('対象ターンだけを再生済みテキストへ差し替える', () => {
    const history = [
      { turnIndex: 0, role: 'assistant' as const, text: '営業部の山田は本日不在です' },
      { turnIndex: 1, role: 'assistant' as const, text: '承知いたしました、少々お待ちください' },
    ];
    const result = truncateConversationHistory(history, { turnIndex: 1, spokenText: '承知いたしました' });
    expect(result[0]?.text).toBe('営業部の山田は本日不在です');
    expect(result[1]?.text).toBe('承知いたしました');
  });

  it('元の配列を変更しない（新しい配列を返す）', () => {
    const history = [{ turnIndex: 0, role: 'assistant' as const, text: 'こんにちは' }];
    const result = truncateConversationHistory(history, { turnIndex: 0, spokenText: 'こん' });
    expect(history[0]?.text).toBe('こんにちは');
    expect(result).not.toBe(history);
  });

  it('該当するターンが無ければ変更なし', () => {
    const history = [{ turnIndex: 0, role: 'assistant' as const, text: 'こんにちは' }];
    const result = truncateConversationHistory(history, { turnIndex: 5, spokenText: 'x' });
    expect(result).toEqual(history);
  });
});
