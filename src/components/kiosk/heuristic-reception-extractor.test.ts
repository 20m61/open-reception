import { describe, expect, it } from 'vitest';
import {
  createHeuristicReceptionUtteranceExtractor,
  looksLikeMultiSlotReceptionUtterance,
} from './heuristic-reception-extractor';
import type { Directory } from './useEffectiveConfiguration';

const directory: Directory = {
  departments: [
    { id: 'sales', name: '営業部' },
    { id: 'dev', name: '開発部' },
  ],
  staff: [
    {
      id: 's1',
      displayName: '鈴木 一郎',
      kana: 'すずきいちろう',
      aliases: ['鈴木さん'],
      departmentId: 'sales',
      available: true,
    },
    {
      id: 's2',
      displayName: '佐藤 花子',
      kana: 'さとうはなこ',
      aliases: ['佐藤さん'],
      departmentId: 'dev',
      available: true,
    },
  ],
};

describe('heuristic reception extractor (#1077)', () => {
  it('「鈴木さんに打ち合わせで来ました。張です」から3slotを提案する', async () => {
    const extractor = createHeuristicReceptionUtteranceExtractor(directory);
    expect(
      await extractor.extract({
        transcript: '営業の鈴木さんに打ち合わせで来ました。張です',
        focus: 'target',
      }),
    ).toMatchObject({
      purpose: { value: 'interview' },
      targetQuery: { value: '鈴木さん' },
      visitorName: { value: '張' },
    });
  });

  it('visitorName focusでは「張」だけでも氏名として提案する', async () => {
    const extractor = createHeuristicReceptionUtteranceExtractor(directory);
    expect(await extractor.extract({ transcript: '張', focus: 'visitorName' })).toMatchObject({
      visitorName: { value: '張' },
    });
  });

  it('担当者だけの「鈴木さん」はvisitorNameに誤認しない', async () => {
    const extractor = createHeuristicReceptionUtteranceExtractor(directory);
    const proposal = await extractor.extract({ transcript: '鈴木さん', focus: 'target' });
    expect(proposal.targetQuery).toMatchObject({ value: '鈴木さん' });
    expect(proposal.visitorName).toBeUndefined();
  });

  it('会社名を自然に含む自己紹介をcompany/nameへ分離する', async () => {
    const extractor = createHeuristicReceptionUtteranceExtractor(directory);
    expect(
      await extractor.extract({
        transcript: '株式会社サンプルの張です。鈴木さんに面会です',
        focus: 'target',
      }),
    ).toMatchObject({
      company: { value: '株式会社サンプル' },
      visitorName: { value: '張' },
      purpose: { value: 'meeting' },
      targetQuery: { value: '鈴木さん' },
    });
  });

  it('multi-slot preflightはtargetだけの発話をclaimせず既存経路を残す', () => {
    expect(looksLikeMultiSlotReceptionUtterance('鈴木さん')).toBe(false);
    expect(looksLikeMultiSlotReceptionUtterance('鈴木さんに打ち合わせで来ました')).toBe(true);
    expect(looksLikeMultiSlotReceptionUtterance('鈴木さんです')).toBe(false);
    expect(looksLikeMultiSlotReceptionUtterance('鈴木さんです。張です')).toBe(true);
  });
});
