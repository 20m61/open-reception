import { describe, expect, it } from 'vitest';
import { bridgeCommittedTurn } from './kiosk-bridge';
import type { Staff } from '@/domain/staff/types';
import type { Department } from '@/domain/department/types';

function staff(id: string, displayName: string, kana: string): Staff {
  return {
    id,
    displayName,
    kana,
    aliases: [],
    departmentId: 'd1',
    enabled: true,
    available: true,
    callTargets: [],
    fallbackStaffIds: [],
  };
}

const departments: Department[] = [
  { id: 'd1', name: '総務部', kana: 'そうむぶ', displayOrder: 0, enabled: true },
];

const directory = {
  staff: [staff('s1', '佐藤', 'さとう'), staff('s2', '鈴木', 'すずき'), staff('s3', '佐野', 'さの')],
  departments,
};

describe('bridgeCommittedTurn (#364 発話確定 → #370 Entity 解決への橋渡し)', () => {
  it('高信頼・完全一致は復唱を挟まず自動採用（heardAccepted）し、対象を解決する', () => {
    const result = bridgeCommittedTurn({ text: 'さとう', directory, sttConfidence: 0.95, t: 10 });
    expect(result.event).toEqual({ type: 'heardAccepted' });
    expect(result.resolved?.id).toBe('s1');
  });

  it('STT confidence が低いと候補が明確でも復唱確認（low_stt_confidence）へ回す', () => {
    const result = bridgeCommittedTurn({ text: 'さとう', directory, sttConfidence: 0.3, t: 20 });
    expect(result.event).toMatchObject({
      type: 'heardNeedsConfirmation',
      displayName: '佐藤',
      reason: 'low_stt_confidence',
    });
    // 「はい」で確定できるよう、解決済み候補を持ち回す
    expect(result.resolved?.id).toBe('s1');
  });

  it('候補が全く無い（解決不能）ときは復唱せず聞き直し（listenStart）を返す', () => {
    const result = bridgeCommittedTurn({ text: 'まったく無関係な語', directory, sttConfidence: 0.9, t: 30 });
    expect(result.event).toEqual({ type: 'listenStart' });
    expect(result.resolved).toBeNull();
  });

  it('低 Entity 信頼（あいまい一致のみ）は復唱確認へ回す', () => {
    // 曖昧な部分一致だけがヒットする語で entityConfidence を下げる
    const result = bridgeCommittedTurn({ text: 'さ', directory, sttConfidence: 0.95, t: 40 });
    expect(result.event.type).toBe('heardNeedsConfirmation');
    expect(result.resolved).not.toBeNull();
  });

  it('PII を返り値へ埋め込まない（resolved は組織辞書の担当者/部門のみ・displayName は表示名）', () => {
    const result = bridgeCommittedTurn({ text: 'さとう', directory, sttConfidence: 0.3, t: 50 });
    // 返り値は担当者辞書由来の値のみ（来訪者の自由入力は含まれない）
    const event = result.event;
    if (event.type === 'heardNeedsConfirmation') {
      const displayName = event.displayName;
      expect(directory.staff.some((s) => s.displayName === displayName)).toBe(true);
    }
  });
});
