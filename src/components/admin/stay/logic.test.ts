import { describe, expect, it } from 'vitest';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import { asStayId, type VisitStay } from '@/domain/visit/types';
import {
  availableActions,
  durationText,
  formatDuration,
  sortStays,
  statusKind,
  statusLabel,
  summarize,
} from './logic';

const NOW = new Date('2026-06-20T18:00:00.000Z');

function stay(over: Partial<VisitStay> = {}): VisitStay {
  return {
    id: asStayId('stay-1'),
    tenantId: asTenantId('t'),
    siteId: asSiteId('s'),
    status: 'present',
    checkedInAt: '2026-06-20T17:00:00.000Z',
    retentionDays: 30,
    createdAt: '2026-06-20T17:00:00.000Z',
    updatedAt: '2026-06-20T17:00:00.000Z',
    ...over,
  };
}

describe('status mapping (issue #102)', () => {
  it('状態ごとに badge 種別とラベルを写す', () => {
    expect(statusKind('present')).toBe('ok');
    expect(statusKind('checked_out')).toBe('maintenance');
    expect(statusKind('cancelled')).toBe('stopped');
    expect(statusLabel('present')).toBe('在館中');
    expect(statusLabel('checked_out')).toBe('退館済み');
    expect(statusLabel('cancelled')).toBe('取消');
  });
});

describe('availableActions (issue #102)', () => {
  it('present のみ退館・取消できる', () => {
    expect(availableActions('present')).toEqual({ canCheckout: true, canCancel: true });
    expect(availableActions('checked_out')).toEqual({ canCheckout: false, canCancel: false });
    expect(availableActions('cancelled')).toEqual({ canCheckout: false, canCancel: false });
  });
});

describe('formatDuration / durationText (issue #102)', () => {
  it('時間と分を整形する', () => {
    expect(formatDuration(30 * 60000)).toBe('30分');
    expect(formatDuration(90 * 60000)).toBe('1時間30分');
  });

  it('在館中は now まで、取消は —', () => {
    expect(durationText(stay(), NOW)).toBe('1時間0分');
    expect(durationText(stay({ status: 'cancelled' }), NOW)).toBe('—');
    expect(durationText(stay({ status: 'checked_out', durationMs: 45 * 60000 }), NOW)).toBe('45分');
  });
});

describe('summarize (issue #102)', () => {
  it('状態別 + 未退館（overstay）を集計する', () => {
    const overstayThreshold = 30 * 60 * 1000;
    const s = summarize(
      [
        stay({ id: asStayId('a') }), // 1h present → overstay
        stay({ id: asStayId('b'), checkedInAt: '2026-06-20T17:50:00.000Z' }), // 10m present
        stay({ id: asStayId('c'), status: 'checked_out' }),
        stay({ id: asStayId('d'), status: 'cancelled' }),
      ],
      NOW,
      overstayThreshold,
    );
    expect(s).toEqual({ total: 4, present: 2, checkedOut: 1, cancelled: 1, overstay: 1 });
  });
});

describe('sortStays (issue #102)', () => {
  it('在館中を先頭に、入館の新しい順', () => {
    const rows = sortStays([
      stay({ id: asStayId('out'), status: 'checked_out' }),
      stay({ id: asStayId('old'), checkedInAt: '2026-06-20T16:00:00.000Z' }),
      stay({ id: asStayId('new'), checkedInAt: '2026-06-20T17:30:00.000Z' }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['new', 'old', 'out']);
  });
});
