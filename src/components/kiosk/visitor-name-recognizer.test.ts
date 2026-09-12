import { describe, expect, it } from 'vitest';
import {
  normalizeVisitorNameCandidates,
  visitorNameRecognitionDisposition,
  type VisitorNameCandidate,
} from './visitor-name-recognizer';

const c = (text: string, certainty: VisitorNameCandidate['certainty'] = 'high'): VisitorNameCandidate => ({
  text,
  certainty,
});

describe('normalizeVisitorNameCandidates (#1057 / #1077)', () => {
  it('空白を除き、trim・dedupe して順序を保つ', () => {
    expect(
      normalizeVisitorNameCandidates([
        c('  山田 太郎  ', 'low'),
        c(''),
        c('山田 太郎', 'high'),
        c('山田 大郎', 'low'),
      ]),
    ).toEqual([c('山田 太郎', 'high'), c('山田 大郎', 'low')]);
  });

  it('既定で4件を超えて来訪者へ提示しない', () => {
    expect(normalizeVisitorNameCandidates([c('A'), c('B'), c('C'), c('D'), c('E')])).toEqual([
      c('A'),
      c('B'),
      c('C'),
      c('D'),
    ]);
  });

  it('0以下の上限なら候補を返さない', () => {
    expect(normalizeVisitorNameCandidates([c('A')], 0)).toEqual([]);
  });

  it('敬称や文言を推測で書き換えない', () => {
    expect(normalizeVisitorNameCandidates([c('山田です')])).toEqual([c('山田です')]);
  });
});

describe('visitorNameRecognitionDisposition (#1077)', () => {
  it('一意かつhighなら氏名だけの確認ターンを増やさずfinal confirmationへ渡せる', () => {
    expect(visitorNameRecognitionDisposition([c('張', 'high')])).toEqual({
      kind: 'accept',
      candidate: c('張', 'high'),
    });
  });

  it('一意でもlowならshort readbackが必要', () => {
    expect(visitorNameRecognitionDisposition([c('チャン', 'low')])).toEqual({
      kind: 'confirm',
      candidate: c('チャン', 'low'),
    });
  });

  it('複数候補なら候補選択でdisambiguationする', () => {
    expect(visitorNameRecognitionDisposition([c('張', 'high'), c('長', 'low')])).toEqual({
      kind: 'choose',
      candidates: [c('張', 'high'), c('長', 'low')],
    });
  });

  it('候補0件はretry/fallbackへ', () => {
    expect(visitorNameRecognitionDisposition([])).toEqual({ kind: 'error' });
  });
});
