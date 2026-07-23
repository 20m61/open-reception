import { describe, expect, it } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import {
  applyEdit,
  applyReissue,
  cancelReservation,
  isExpiredAt,
  isUsableAt,
  markExpiredIfNeeded,
  markUsed,
  revokeReservation,
  validateCreateInput,
} from './lifecycle';
import {
  asReservationId,
  asReservationTokenHash,
  type CreateReservationInput,
  type VisitReservation,
} from './types';

const T = asTenantId('tenant-a');
const S = asSiteId('site-1');

function reservation(over: Partial<VisitReservation> = {}): VisitReservation {
  return {
    id: asReservationId('rsv-1'),
    tenantId: T,
    siteId: S,
    visitorName: '山田太郎',
    visitAt: '2026-06-20T01:00:00.000Z',
    targetType: 'staff',
    targetId: 'staff-1',
    tokenHash: asReservationTokenHash('hash-1'),
    usagePolicy: 'single_use',
    expiresAt: '2026-06-27T00:00:00.000Z',
    status: 'active',
    retentionDays: 30,
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
    ...over,
  };
}

function input(over: Partial<CreateReservationInput> = {}): CreateReservationInput {
  return {
    tenantId: T,
    siteId: S,
    visitorName: '山田太郎',
    visitAt: '2026-06-20T01:00:00.000Z',
    targetType: 'staff',
    targetId: 'staff-1',
    usagePolicy: 'single_use',
    expiresAt: '2026-06-27T00:00:00.000Z',
    retentionDays: 30,
    ...over,
  };
}

describe('validateCreateInput (#97)', () => {
  it('正常入力を受理する', () => {
    expect(validateCreateInput(input()).ok).toBe(true);
  });
  it.each([
    ['visitorName 空', input({ visitorName: ' ' })],
    ['visitAt 不正', input({ visitAt: 'nope' })],
    ['expiresAt 不正', input({ expiresAt: 'nope' })],
    ['targetId 空', input({ targetId: '' })],
    ['retentionDays 0', input({ retentionDays: 0 })],
    ['expiresAt < visitAt', input({ expiresAt: '2026-06-19T00:00:00.000Z' })],
  ])('%s を拒否する', (_label, bad) => {
    const r = validateCreateInput(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_input');
  });
});

describe('期限・使用可否判定 (#97)', () => {
  const now = new Date('2026-06-20T02:00:00.000Z');
  it('isExpiredAt: 期限後で true', () => {
    expect(isExpiredAt(reservation({ expiresAt: '2026-06-20T01:00:00.000Z' }), now)).toBe(true);
    expect(isExpiredAt(reservation({ expiresAt: '2026-06-21T00:00:00.000Z' }), now)).toBe(false);
  });
  it('isUsableAt: active かつ期限内なら true', () => {
    expect(isUsableAt(reservation(), now)).toBe(true);
  });
  it('isUsableAt: 非 active は false', () => {
    expect(isUsableAt(reservation({ status: 'revoked' }), now)).toBe(false);
    expect(isUsableAt(reservation({ status: 'used' }), now)).toBe(false);
  });
  it('isUsableAt: same_day は当日のみ', () => {
    const sameDay = reservation({ usagePolicy: 'same_day' });
    expect(isUsableAt(sameDay, new Date('2026-06-20T05:00:00.000Z'))).toBe(true);
    expect(isUsableAt(sameDay, new Date('2026-06-21T05:00:00.000Z'))).toBe(false);
  });
});

describe('状態遷移 (#97)', () => {
  const now = new Date('2026-06-20T02:00:00.000Z');

  it('cancel: active → cancelled、終端からは不可', () => {
    const ok = cancelReservation(reservation(), now);
    expect(ok.ok && ok.value.status).toBe('cancelled');
    const bad = cancelReservation(reservation({ status: 'used' }), now);
    expect(bad.ok).toBe(false);
  });

  it('revoke: active → revoked、終端からは不可', () => {
    const ok = revokeReservation(reservation(), now);
    expect(ok.ok && ok.value.status).toBe('revoked');
    expect(revokeReservation(reservation({ status: 'cancelled' }), now).ok).toBe(false);
  });

  it('markExpiredIfNeeded: 期限切れ active のみ expired（冪等）', () => {
    const expired = markExpiredIfNeeded(reservation({ expiresAt: '2026-06-20T01:00:00.000Z' }), now);
    expect(expired.ok && expired.value.status).toBe('expired');
    const stillActive = markExpiredIfNeeded(reservation(), now);
    expect(stillActive.ok && stillActive.value.status).toBe('active');
  });

  it('markUsed: 利用可能なら used、不可なら invalid_state', () => {
    const used = markUsed(reservation(), now);
    expect(used.ok && used.value.status).toBe('used');
    expect(used.ok && used.value.usedAt).toBeDefined();
    const bad = markUsed(reservation({ status: 'revoked' }), now);
    expect(bad.ok).toBe(false);
  });

  it('applyReissue: 新トークン hash・期限を適用し active へ戻す', () => {
    const revoked = reservation({ status: 'revoked', tokenHash: asReservationTokenHash('old-hash') });
    const r = applyReissue(revoked, asReservationTokenHash('new-hash'), '2026-07-01T00:00:00.000Z', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tokenHash).toBe('new-hash');
      expect(r.value.status).toBe('active');
      expect(r.value.usedAt).toBeUndefined();
    }
  });

  it('applyReissue: cancelled からは不可', () => {
    const r = applyReissue(reservation({ status: 'cancelled' }), asReservationTokenHash('x'), '2026-07-01T00:00:00.000Z', now);
    expect(r.ok).toBe(false);
  });

  it('applyEdit: active のみ編集可、終端は拒否', () => {
    const ok = applyEdit(reservation(), { visitorName: '田中花子' }, now);
    expect(ok.ok && ok.value.visitorName).toBe('田中花子');
    const bad = applyEdit(reservation({ status: 'used' }), { visitorName: 'x' }, now);
    expect(bad.ok).toBe(false);
  });

  it('applyEdit: expiresAt < visitAt を拒否', () => {
    const r = applyEdit(reservation(), { expiresAt: '2026-06-19T00:00:00.000Z' }, now);
    expect(r.ok).toBe(false);
  });
});
