import { describe, expect, it } from 'vitest';
import { asStayId, type VisitStay } from '@/domain/visit/types';
import type { SiteId, TenantId } from '@/domain/tenant/types';
import { filterStays, staysToCsv, type StayListFilter } from './list-filter';

function fixture(overrides: Partial<VisitStay> = {}): VisitStay {
  return {
    id: asStayId('stay-1'),
    tenantId: 'internal' as TenantId,
    siteId: 'default' as SiteId,
    status: 'present',
    checkedInAt: '2026-07-01T01:00:00.000Z',
    retentionDays: 30,
    createdAt: '2026-07-01T01:00:00.000Z',
    updatedAt: '2026-07-01T01:00:00.000Z',
    ...overrides,
  };
}

describe('filterStays: 在館状況一覧の検索・フィルタ純関数 (issue #330 item2 残増分)', () => {
  it('未指定条件は全件を返す', () => {
    const items = [fixture(), fixture({ id: asStayId('stay-2') })];
    expect(filterStays(items, {})).toHaveLength(2);
  });

  it('入館日時（checkedInAt）を JST 暦日境界でフィルタする', () => {
    const items = [
      fixture({ id: asStayId('a'), checkedInAt: '2026-06-30T20:00:00.000Z' }), // JST 07-01 05:00
      fixture({ id: asStayId('b'), checkedInAt: '2026-07-02T01:00:00.000Z' }), // JST 07-02
    ];
    const filter: StayListFilter = { start: '2026-07-01', end: '2026-07-01' };
    expect(filterStays(items, filter).map((s) => s.id)).toEqual(['a']);
  });

  it('状態で絞り込む', () => {
    const items = [
      fixture({ id: asStayId('a'), status: 'present' }),
      fixture({ id: asStayId('b'), status: 'checked_out', checkedOutAt: '2026-07-01T02:00:00.000Z' }),
    ];
    expect(filterStays(items, { status: 'checked_out' }).map((s) => s.id)).toEqual(['b']);
  });
});

describe('staysToCsv: 在館状況 CSV 変換（PII を含まない）', () => {
  it('ヘッダ行 + データ行を出力する', () => {
    const now = new Date('2026-07-01T02:00:00.000Z');
    const csv = staysToCsv([fixture()], now);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('受付番号,入館,退館,滞在時間,状態');
    expect(lines[1]).toContain('stay-1');
  });
});
