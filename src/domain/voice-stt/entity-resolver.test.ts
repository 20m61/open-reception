import { describe, it, expect } from 'vitest';
import { MOCK_STAFF, MOCK_DEPARTMENTS } from '@/domain/staff/mock-data';
import {
  DEFAULT_ENTITY_RESOLUTION_THRESHOLDS,
  applyContextBoost,
  decideEntityConfirmation,
  resolveDepartmentEntities,
  resolveEntities,
  resolveStaffEntities,
  shouldSpeculativelyResolve,
  type EntityCandidate,
} from './entity-resolver';

describe('shouldSpeculativelyResolve', () => {
  it('is false for empty or too-short partials', () => {
    expect(shouldSpeculativelyResolve('')).toBe(false);
    expect(shouldSpeculativelyResolve('た')).toBe(false);
  });

  it('is true once the partial reaches the minimum length', () => {
    expect(shouldSpeculativelyResolve('たな')).toBe(true);
    expect(shouldSpeculativelyResolve('たなか')).toBe(true);
  });
});

describe('resolveStaffEntities', () => {
  it('returns staff candidates scored by match tier, descending', () => {
    const candidates = resolveStaffEntities(MOCK_STAFF, '佐藤');
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.id).toBe('staff-sato');
    expect(candidates[0]!.kind).toBe('staff');
    for (let i = 1; i < candidates.length; i += 1) {
      expect(candidates[i]!.entityConfidence).toBeLessThanOrEqual(candidates[i - 1]!.entityConfidence);
    }
  });

  it('excludes disabled staff', () => {
    const candidates = resolveStaffEntities(MOCK_STAFF, '山田');
    expect(candidates.find((c) => c.id === 'staff-yamada')).toBeUndefined();
  });

  it('gives an exact match the highest confidence tier', () => {
    const [top] = resolveStaffEntities(MOCK_STAFF, '佐藤 太郎');
    expect(top!.entityConfidence).toBe(1);
  });
});

describe('resolveDepartmentEntities', () => {
  it('returns department candidates', () => {
    const candidates = resolveDepartmentEntities(MOCK_DEPARTMENTS, '営業部');
    expect(candidates[0]!.id).toBe('dept-sales');
    expect(candidates[0]!.kind).toBe('department');
  });

  it('excludes disabled departments', () => {
    const candidates = resolveDepartmentEntities(MOCK_DEPARTMENTS, '総務部');
    expect(candidates.find((c) => c.id === 'dept-old')).toBeUndefined();
  });
});

describe('resolveEntities', () => {
  it('merges staff and department candidates, sorted by confidence, capped at top3', () => {
    const result = resolveEntities({ staff: MOCK_STAFF, departments: MOCK_DEPARTMENTS }, '佐藤');
    expect(result.query).toBe('佐藤');
    expect(result.top3.length).toBeLessThanOrEqual(3);
    expect(result.top1).toEqual(result.top3[0] ?? null);
    for (let i = 1; i < result.top3.length; i += 1) {
      expect(result.top3[i]!.entityConfidence).toBeLessThanOrEqual(result.top3[i - 1]!.entityConfidence);
    }
  });

  it('returns a null top1 when nothing matches', () => {
    const result = resolveEntities({ staff: MOCK_STAFF, departments: MOCK_DEPARTMENTS }, 'ｚｚｚｚ');
    expect(result.top1).toBeNull();
    expect(result.top3).toEqual([]);
  });
});

describe('applyContextBoost', () => {
  it('boosts candidates that match today-schedule or reservation context, without reordering ties incorrectly', () => {
    const candidates: EntityCandidate[] = [
      { id: 'staff-a', kind: 'staff', displayName: 'A', entityConfidence: 0.6 },
      { id: 'staff-b', kind: 'staff', displayName: 'B', entityConfidence: 0.6 },
    ];
    const boosted = applyContextBoost(candidates, { reservationStaffIds: ['staff-b'] });
    const b = boosted.find((c) => c.id === 'staff-b')!;
    const a = boosted.find((c) => c.id === 'staff-a')!;
    expect(b.entityConfidence).toBeGreaterThan(a.entityConfidence);
  });

  it('never boosts confidence above 1', () => {
    const candidates: EntityCandidate[] = [
      { id: 'staff-a', kind: 'staff', displayName: 'A', entityConfidence: 0.95 },
    ];
    const boosted = applyContextBoost(candidates, { qrStaffId: 'staff-a', reservationStaffIds: ['staff-a'] });
    expect(boosted[0]!.entityConfidence).toBeLessThanOrEqual(1);
  });

  it('is a no-op when no context is provided', () => {
    const candidates: EntityCandidate[] = [
      { id: 'staff-a', kind: 'staff', displayName: 'A', entityConfidence: 0.6 },
    ];
    expect(applyContextBoost(candidates, {})).toEqual(candidates);
  });
});

describe('decideEntityConfirmation', () => {
  const highConfidenceTop3: EntityCandidate[] = [
    { id: 'staff-sato', kind: 'staff', displayName: '佐藤 太郎', entityConfidence: 1 },
  ];

  it('requires confirmation when STT confidence itself is low, even with a strong entity match', () => {
    const event = decideEntityConfirmation(0.4, highConfidenceTop3, DEFAULT_ENTITY_RESOLUTION_THRESHOLDS, 1000);
    expect(event).not.toBeNull();
    expect(event!.reason).toBe('low_stt_confidence');
    expect(event!.t).toBe(1000);
  });

  it('requires confirmation when there is no candidate at all', () => {
    const event = decideEntityConfirmation(0.9, [], DEFAULT_ENTITY_RESOLUTION_THRESHOLDS, 1000);
    expect(event).not.toBeNull();
    expect(event!.reason).toBe('low_entity_confidence');
    expect(event!.top1).toBeNull();
  });

  it('requires confirmation when the top1 entity confidence is low', () => {
    const low: EntityCandidate[] = [{ id: 'staff-a', kind: 'staff', displayName: 'A', entityConfidence: 0.3 }];
    const event = decideEntityConfirmation(0.9, low, DEFAULT_ENTITY_RESOLUTION_THRESHOLDS, 1000);
    expect(event!.reason).toBe('low_entity_confidence');
  });

  it('requires confirmation when top1 and top2 are too close (ambiguous)', () => {
    const ambiguous: EntityCandidate[] = [
      { id: 'staff-a', kind: 'staff', displayName: 'A', entityConfidence: 0.62 },
      { id: 'staff-b', kind: 'staff', displayName: 'B', entityConfidence: 0.6 },
    ];
    const event = decideEntityConfirmation(0.9, ambiguous, DEFAULT_ENTITY_RESOLUTION_THRESHOLDS, 1000);
    expect(event!.reason).toBe('ambiguous_candidates');
  });

  it('returns null (no confirmation needed) when both confidences are high and unambiguous', () => {
    const event = decideEntityConfirmation(0.95, highConfidenceTop3, DEFAULT_ENTITY_RESOLUTION_THRESHOLDS, 1000);
    expect(event).toBeNull();
  });

  it('keeps sttConfidence and entityConfidence as separately inspectable numbers on the event', () => {
    const low: EntityCandidate[] = [{ id: 'staff-a', kind: 'staff', displayName: 'A', entityConfidence: 0.3 }];
    const event = decideEntityConfirmation(0.99, low, DEFAULT_ENTITY_RESOLUTION_THRESHOLDS, 500)!;
    expect(event.sttConfidence).toBe(0.99);
    expect(event.top1!.entityConfidence).toBe(0.3);
  });
});
