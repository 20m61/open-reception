import { describe, expect, it } from 'vitest';
import type { Directory } from './useEffectiveConfiguration';
import { voiceTargetCandidatesFor } from './voice-target-candidates';

const DIRECTORY: Directory = {
  departments: [
    { id: 'dept-sales', name: '営業部' },
    { id: 'dept-dev', name: '開発部' },
  ],
  staff: [
    {
      id: 'staff-sato-sales',
      displayName: '佐藤 太郎',
      kana: 'さとう',
      aliases: ['sato'],
      departmentId: 'dept-sales',
      available: true,
    },
    {
      id: 'staff-sato-dev',
      displayName: '佐藤 花子',
      kana: 'さとう',
      aliases: [],
      departmentId: 'dept-dev',
      available: true,
    },
    {
      id: 'staff-suzuki',
      displayName: '鈴木 一郎',
      kana: 'すずき',
      aliases: [],
      departmentId: 'dept-dev',
      available: false,
    },
    {
      id: 'staff-tanaka',
      displayName: '田中 次郎',
      kana: 'たなか',
      aliases: [],
      departmentId: 'dept-dev',
      available: true,
    },
  ],
};

describe('voiceTargetCandidatesFor (#1057)', () => {
  it('STT 結果を実在する在席担当者の候補へ変換する', () => {
    const result = voiceTargetCandidatesFor(DIRECTORY, ['さとう']);
    expect(result.map((candidate) => candidate.staff.id)).toEqual([
      'staff-sato-sales',
      'staff-sato-dev',
    ]);
    expect(result.every((candidate) => candidate.tier === 'exact')).toBe(true);
  });

  it('同姓候補を自動確定せず複数返す', () => {
    const result = voiceTargetCandidatesFor(DIRECTORY, ['佐藤']);
    expect(result).toHaveLength(2);
    expect(new Set(result.map((candidate) => candidate.staff.departmentId))).toEqual(
      new Set(['dept-sales', 'dept-dev']),
    );
  });

  it('不在担当者は候補に含めない', () => {
    expect(voiceTargetCandidatesFor(DIRECTORY, ['すずき'])).toEqual([]);
  });

  it('強い一致があるとき弱い fuzzy 候補を混ぜない', () => {
    const result = voiceTargetCandidatesFor(DIRECTORY, ['たなか']);
    expect(result.map((candidate) => candidate.staff.id)).toEqual(['staff-tanaka']);
    expect(result[0]?.tier).toBe('exact');
  });

  it('複数の STT 候補で同じ担当者が出ても重複させない', () => {
    const result = voiceTargetCandidatesFor(DIRECTORY, ['佐藤 太郎', 'さとう']);
    expect(result.filter((candidate) => candidate.staff.id === 'staff-sato-sales')).toHaveLength(1);
  });

  it('画面で判断できる候補数へ上限をかける', () => {
    const result = voiceTargetCandidatesFor(DIRECTORY, ['さとう', 'たなか'], 2);
    expect(result).toHaveLength(2);
  });

  it('空文字と 0 件は安全に無視する', () => {
    expect(voiceTargetCandidatesFor(DIRECTORY, ['', '   ', '該当なし'])).toEqual([]);
    expect(voiceTargetCandidatesFor(DIRECTORY, ['さとう'], 0)).toEqual([]);
  });
});
