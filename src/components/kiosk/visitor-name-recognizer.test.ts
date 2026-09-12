import { describe, expect, it } from 'vitest';
import { normalizeVisitorNameCandidates } from './visitor-name-recognizer';

describe('normalizeVisitorNameCandidates (#1057)', () => {
  it('空白を除き、trim・dedupe して順序を保つ', () => {
    expect(
      normalizeVisitorNameCandidates(['  山田 太郎  ', '', '山田 太郎', '山田 大郎']),
    ).toEqual(['山田 太郎', '山田 大郎']);
  });

  it('既定で4件を超えて来訪者へ提示しない', () => {
    expect(normalizeVisitorNameCandidates(['A', 'B', 'C', 'D', 'E'])).toEqual([
      'A',
      'B',
      'C',
      'D',
    ]);
  });

  it('0以下の上限なら候補を返さない', () => {
    expect(normalizeVisitorNameCandidates(['A'], 0)).toEqual([]);
  });

  it('敬称や文言を推測で書き換えない', () => {
    expect(normalizeVisitorNameCandidates(['山田です'])).toEqual(['山田です']);
  });
});
