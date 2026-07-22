import { describe, expect, it } from 'vitest';
import { voiceCandidateToTarget } from './voice-target-binding';
import type { EntityCandidate } from '@/domain/voice-stt/entity-resolver';

function candidate(overrides: Partial<EntityCandidate> = {}): EntityCandidate {
  return { id: 's1', kind: 'staff', displayName: '佐藤', entityConfidence: 0.9, ...overrides };
}

describe('voiceCandidateToTarget (#364 音声確定 → 相手選択の写像)', () => {
  it('staff 候補はタッチ onSelect と同一構造の相手を返す（{type,id,label}）', () => {
    const t = voiceCandidateToTarget(candidate({ id: 'staff-suzuki', displayName: 'デモ 鈴木' }));
    expect(t).toEqual({ type: 'staff', id: 'staff-suzuki', label: 'デモ 鈴木' });
  });

  it('department 候補は department 相手を返す', () => {
    const t = voiceCandidateToTarget(
      candidate({ kind: 'department', id: 'dept-sales', displayName: '営業部' }),
    );
    expect(t).toEqual({ type: 'department', id: 'dept-sales', label: '営業部' });
  });

  it('候補なし（null）は null（何も選択しない）', () => {
    expect(voiceCandidateToTarget(null)).toBeNull();
  });

  it('purpose / other は相手ではないので null（相手選択に使わない）', () => {
    expect(voiceCandidateToTarget(candidate({ kind: 'purpose' }))).toBeNull();
    expect(voiceCandidateToTarget(candidate({ kind: 'other' }))).toBeNull();
  });

  it('label は displayName をそのまま使う（タッチ経路の label と一致 = 後勝ちが破綻しない）', () => {
    const t = voiceCandidateToTarget(candidate({ id: 'staff-sato', displayName: 'デモ 佐藤' }));
    // タッチ側 onSelect({ type:'staff', id:s.id, label:s.displayName }) と同じ形。
    expect(t).toEqual({ type: 'staff', id: 'staff-sato', label: 'デモ 佐藤' });
  });
});
