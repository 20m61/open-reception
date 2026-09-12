import { describe, expect, it } from 'vitest';
import type { Department } from '@/domain/department/types';
import type { Staff } from '@/domain/staff/types';
import {
  resolveReceptionSlotProposal,
  type ReceptionSlotProposal,
} from './slot-proposal';
import type { EntityDirectory } from '@/domain/voice-stt/entity-resolver';

function staff(
  id: string,
  displayName: string,
  kana: string,
  departmentId = 'dept-sales',
): Staff {
  return {
    id,
    displayName,
    kana,
    aliases: [],
    departmentId,
    enabled: true,
    available: true,
    callTargets: [],
    fallbackStaffIds: [],
  };
}

const departments: Department[] = [
  {
    id: 'dept-sales',
    name: '営業部',
    kana: 'えいぎょうぶ',
    displayOrder: 0,
    enabled: true,
  },
];

const directory: EntityDirectory = {
  staff: [
    staff('staff-suzuki', '鈴木 一郎', 'すずき'),
    staff('staff-sato', '佐藤 花子', 'さとう'),
  ],
  departments,
};

const resolve = (
  proposal: ReceptionSlotProposal,
  sttConfidence = 0.95,
) =>
  resolveReceptionSlotProposal(proposal, {
    directory,
    sttConfidence,
  });

describe('resolveReceptionSlotProposal (#1081)', () => {
  it('一発話からpurpose / actual target / visitorNameを同時にdraft候補へ変換する', () => {
    const result = resolve({
      purpose: { value: 'meeting', confidence: 0.95 },
      targetQuery: { value: '鈴木 一郎', confidence: 0.95 },
      visitorName: { value: ' 張 ', confidence: 0.95 },
    });

    expect(result.purpose).toEqual({
      kind: 'resolved',
      value: 'meeting',
      evidence: { source: 'voice', certainty: 'high' },
    });
    expect(result.target).toEqual({
      kind: 'resolved',
      value: { type: 'staff', id: 'staff-suzuki', label: '鈴木 一郎' },
      evidence: { source: 'voice', certainty: 'high' },
    });
    expect(result.visitorName).toEqual({
      kind: 'resolved',
      value: '張',
      evidence: { source: 'voice', certainty: 'high' },
    });
  });

  it('extractorがtarget idを出せずqueryだけでも、directory resolverで実在entityへ結びつく', () => {
    const result = resolve({
      targetQuery: { value: '営業部', confidence: 0.95 },
    });

    expect(result.target).toEqual({
      kind: 'resolved',
      value: { type: 'department', id: 'dept-sales', label: '営業部' },
      evidence: { source: 'voice', certainty: 'high' },
    });
  });

  it('directoryに存在しないtarget queryから架空IDを生成しない', () => {
    const result = resolve({
      targetQuery: { value: '存在しない宇宙開発部', confidence: 0.99 },
    });
    expect(result.target).toBeUndefined();
  });

  it('extractor confidenceが低ければ、一意候補でもresolvedにせずrepair対象にする', () => {
    const result = resolve({
      targetQuery: { value: '鈴木 一郎', confidence: 0.4 },
    });
    expect(result.target).toEqual({
      kind: 'ambiguous',
      candidates: [{ type: 'staff', id: 'staff-suzuki', label: '鈴木 一郎' }],
      evidence: { source: 'voice', certainty: 'ambiguous' },
    });
  });

  it('STT confidenceが低ければ、extractorが高信頼でもtargetをrepair対象にする', () => {
    const result = resolve(
      { targetQuery: { value: '鈴木 一郎', confidence: 0.95 } },
      0.3,
    );
    expect(result.target?.kind).toBe('ambiguous');
  });

  it('visitorName低信頼は1候補ambiguousとしてshort readback対象にする', () => {
    const result = resolve({
      visitorName: { value: 'チャン', confidence: 0.45 },
    });
    expect(result.visitorName).toEqual({
      kind: 'ambiguous',
      candidates: ['チャン'],
      evidence: { source: 'voice', certainty: 'ambiguous' },
    });
  });

  it('companyは発話に含まれた時だけ保持できるが、低信頼なら確定しない', () => {
    expect(resolve({}).company).toBeUndefined();
    expect(
      resolve({ company: { value: '株式会社サンプル', confidence: 0.5 } }).company,
    ).toEqual({
      kind: 'ambiguous',
      candidates: ['株式会社サンプル'],
      evidence: { source: 'voice', certainty: 'ambiguous' },
    });
  });

  it('空文字やNaN confidenceをresolved slotとして通さない', () => {
    const result = resolve({
      targetQuery: { value: ' ', confidence: 1 },
      visitorName: { value: ' ', confidence: 1 },
      company: { value: 'Example', confidence: Number.NaN },
    });
    expect(result.target).toBeUndefined();
    expect(result.visitorName).toBeUndefined();
    expect(result.company).toEqual({
      kind: 'ambiguous',
      candidates: ['Example'],
      evidence: { source: 'voice', certainty: 'ambiguous' },
    });
  });

  it('同名に近い複数候補は実在entity候補のままambiguousにする', () => {
    const sameNameDirectory: EntityDirectory = {
      staff: [
        staff('staff-sato-sales', '佐藤', 'さとう', 'dept-sales'),
        staff('staff-sato-dev', '佐藤', 'さとう', 'dept-dev'),
      ],
      departments: [
        ...departments,
        {
          id: 'dept-dev',
          name: '開発部',
          kana: 'かいはつぶ',
          displayOrder: 1,
          enabled: true,
        },
      ],
    };

    const result = resolveReceptionSlotProposal(
      { targetQuery: { value: '佐藤', confidence: 0.95 } },
      { directory: sameNameDirectory, sttConfidence: 0.95 },
    );

    expect(result.target?.kind).toBe('ambiguous');
    if (result.target?.kind !== 'ambiguous') throw new Error('expected ambiguous target');
    expect(result.target.candidates.map((candidate) => candidate.id)).toEqual([
      'staff-sato-sales',
      'staff-sato-dev',
    ]);
  });
});
