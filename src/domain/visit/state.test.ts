import { describe, expect, it } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import { cancelStay, checkOut, elapsedMs, isOverstay, stayDurationMs } from './state';
import { asStayId, type VisitStay } from './types';

const NOW = new Date('2026-06-20T10:00:00.000Z');

function stay(over: Partial<VisitStay> = {}): VisitStay {
  return {
    id: asStayId('stay-1'),
    tenantId: asTenantId('t'),
    siteId: asSiteId('s'),
    status: 'present',
    checkedInAt: '2026-06-20T09:00:00.000Z',
    retentionDays: 30,
    createdAt: '2026-06-20T09:00:00.000Z',
    updatedAt: '2026-06-20T09:00:00.000Z',
    ...over,
  };
}

describe('checkOut (issue #102)', () => {
  it('present → checked_out で退館時刻と滞在時間を確定する', () => {
    const r = checkOut(stay(), NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.status).toBe('checked_out');
      expect(r.value.checkedOutAt).toBe(NOW.toISOString());
      expect(r.value.durationMs).toBe(60 * 60 * 1000); // 1 時間
      expect(r.value.updatedAt).toBe(NOW.toISOString());
    }
  });

  it('二重退館を防ぐ（checked_out からは invalid_state）', () => {
    const once = checkOut(stay(), NOW);
    expect(once.ok).toBe(true);
    if (once.ok) {
      const twice = checkOut(once.value, new Date('2026-06-20T11:00:00.000Z'));
      expect(twice).toEqual({
        ok: false,
        error: { code: 'invalid_state', message: 'cannot check out a checked_out stay' },
      });
    }
  });

  it('取消済みからは退館できない', () => {
    const r = checkOut(stay({ status: 'cancelled' }), NOW);
    expect(r.ok).toBe(false);
  });
});

describe('cancelStay (issue #102)', () => {
  it('present → cancelled', () => {
    const r = cancelStay(stay(), NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.status).toBe('cancelled');
  });

  it('終端からは取り消せない', () => {
    expect(cancelStay(stay({ status: 'checked_out' }), NOW).ok).toBe(false);
    expect(cancelStay(stay({ status: 'cancelled' }), NOW).ok).toBe(false);
  });
});

describe('isOverstay (issue #102)', () => {
  const threshold = 30 * 60 * 1000; // 30 分

  it('present かつ閾値超過なら true', () => {
    expect(isOverstay(stay(), NOW, threshold)).toBe(true);
  });

  it('present でも閾値未満なら false', () => {
    expect(isOverstay(stay({ checkedInAt: '2026-06-20T09:50:00.000Z' }), NOW, threshold)).toBe(false);
  });

  it('退館済み / 取消は overstay にならない', () => {
    expect(isOverstay(stay({ status: 'checked_out' }), NOW, threshold)).toBe(false);
    expect(isOverstay(stay({ status: 'cancelled' }), NOW, threshold)).toBe(false);
  });
});

describe('stayDurationMs / elapsedMs (issue #102)', () => {
  it('負の時間は 0 に丸める', () => {
    expect(stayDurationMs('2026-06-20T10:00:00.000Z', '2026-06-20T09:00:00.000Z')).toBe(0);
  });

  it('present は now まで、退館済みは確定値を返す', () => {
    expect(elapsedMs(stay(), NOW)).toBe(60 * 60 * 1000);
    expect(elapsedMs(stay({ status: 'checked_out', durationMs: 123 }), NOW)).toBe(123);
  });
});
