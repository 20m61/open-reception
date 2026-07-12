import { describe, expect, it } from 'vitest';
import type { VisitReservation } from '@/domain/reservation/types';
import {
  asReservationId,
  asReservationToken,
} from '@/domain/reservation/types';
import type { SiteId, TenantId } from '@/domain/tenant/types';
import { filterReservations, reservationsToCsv, type ReservationListFilter } from './list-filter';

function fixture(overrides: Partial<VisitReservation> = {}): VisitReservation {
  return {
    id: asReservationId('rsv-1'),
    tenantId: 'internal' as TenantId,
    siteId: 'default' as SiteId,
    visitorName: '来客 太郎',
    companyName: '来客商事',
    visitAt: '2026-07-01T01:00:00.000Z',
    targetType: 'staff',
    targetId: 'staff-1',
    token: asReservationToken('tok-1'),
    usagePolicy: 'single_use',
    expiresAt: '2026-07-02T00:00:00.000Z',
    status: 'active',
    retentionDays: 30,
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
    ...overrides,
  };
}

describe('filterReservations: 来訪予約一覧の検索・フィルタ純関数 (issue #330 item2 残増分)', () => {
  it('未指定条件は全件を返す', () => {
    const items = [fixture(), fixture({ id: asReservationId('rsv-2') })];
    expect(filterReservations(items, {})).toHaveLength(2);
  });

  it('予定日時（visitAt）を JST 暦日境界でフィルタする', () => {
    const items = [
      fixture({ id: asReservationId('a'), visitAt: '2026-06-30T20:00:00.000Z' }), // JST 07-01 05:00
      fixture({ id: asReservationId('b'), visitAt: '2026-07-02T01:00:00.000Z' }), // JST 07-02
    ];
    const filter: ReservationListFilter = { start: '2026-07-01', end: '2026-07-01' };
    expect(filterReservations(items, filter).map((r) => r.id)).toEqual(['a']);
  });

  it('状態で絞り込む', () => {
    const items = [
      fixture({ id: asReservationId('a'), status: 'active' }),
      fixture({ id: asReservationId('b'), status: 'revoked' }),
    ];
    expect(filterReservations(items, { status: 'revoked' }).map((r) => r.id)).toEqual(['b']);
  });

  it('呼び出し先種別で絞り込む', () => {
    const items = [
      fixture({ id: asReservationId('a'), targetType: 'staff' }),
      fixture({ id: asReservationId('b'), targetType: 'department' }),
    ];
    expect(filterReservations(items, { targetType: 'department' }).map((r) => r.id)).toEqual(['b']);
  });

  it('条件は AND で組み合わさる', () => {
    const items = [
      fixture({ id: asReservationId('a'), status: 'active', targetType: 'staff' }),
      fixture({ id: asReservationId('b'), status: 'active', targetType: 'department' }),
      fixture({ id: asReservationId('c'), status: 'revoked', targetType: 'staff' }),
    ];
    const filter: ReservationListFilter = { status: 'active', targetType: 'staff' };
    expect(filterReservations(items, filter).map((r) => r.id)).toEqual(['a']);
  });
});

describe('reservationsToCsv: 来訪予約 CSV 変換（PII を含めない）', () => {
  it('氏名・会社名等の PII をヘッダ/行に含めない', () => {
    const csv = reservationsToCsv([fixture()]);
    expect(csv).not.toContain('来客 太郎');
    expect(csv).not.toContain('来客商事');
    expect(csv).toContain('予定日時');
    expect(csv).toContain('staff-1');
  });

  it('ヘッダ行 + データ行を出力する', () => {
    const csv = reservationsToCsv([fixture()]);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('予定日時,呼び出し先種別,呼び出し先ID,利用制約,状態,有効期限');
  });
});
