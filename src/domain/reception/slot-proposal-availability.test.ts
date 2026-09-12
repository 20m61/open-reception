import { describe, expect, it } from 'vitest';
import type { Staff } from '@/domain/staff/types';
import type { EntityDirectory } from '@/domain/voice-stt/entity-resolver';
import { resolveReceptionSlotProposal } from './slot-proposal';

function staff(id: string, displayName: string, available: boolean): Staff {
  return {
    id,
    displayName,
    kana: displayName,
    aliases: [],
    departmentId: 'dept-sales',
    enabled: true,
    available,
    callTargets: [],
    fallbackStaffIds: [],
  };
}

describe('voice target availability (#1081 / #1082)', () => {
  it('不在担当者をhigh-confidence resolved targetとして通さない', () => {
    const directory: EntityDirectory = {
      staff: [staff('staff-suzuki', '鈴木', false)],
      departments: [],
    };

    const result = resolveReceptionSlotProposal(
      { targetQuery: { value: '鈴木', confidence: 0.99 } },
      { directory, sttConfidence: 0.99 },
    );

    expect(result.target).toBeUndefined();
  });

  it('同じ姓でも在席候補だけをrepair候補へ残す', () => {
    const directory: EntityDirectory = {
      staff: [
        staff('staff-sato-away', '佐藤', false),
        staff('staff-sato-here', '佐藤', true),
      ],
      departments: [],
    };

    const result = resolveReceptionSlotProposal(
      { targetQuery: { value: '佐藤', confidence: 0.99 } },
      { directory, sttConfidence: 0.99 },
    );

    expect(result.target).toEqual({
      kind: 'resolved',
      value: { type: 'staff', id: 'staff-sato-here', label: '佐藤' },
      evidence: { source: 'voice', certainty: 'high' },
    });
  });
});
