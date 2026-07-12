import { describe, expect, it } from 'vitest';
import { asSiteId, asTenantId, type SiteStatus } from '@/domain/tenant/types';
import type { SiteWithDevices } from '@/lib/tenant/site-service';
import { filterSites, sitesToCsv, type SiteListFilter } from './sites-filter';

function fixture(overrides: Partial<SiteWithDevices> = {}): SiteWithDevices {
  return {
    id: asSiteId('site-1'),
    tenantId: asTenantId('internal'),
    name: '本社受付',
    status: 'active',
    deviceCount: 2,
    onlineDeviceCount: 1,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('filterSites: 拠点一覧の検索・フィルタ純関数 (issue #330 item2 残増分)', () => {
  it('未指定条件は全件を返す', () => {
    const items = [fixture(), fixture({ id: asSiteId('site-2') })];
    expect(filterSites(items, {})).toHaveLength(2);
  });

  it('拠点名の部分一致（大文字小文字を無視）で絞り込む', () => {
    const items = [
      fixture({ id: asSiteId('a'), name: '本社受付' }),
      fixture({ id: asSiteId('b'), name: '大阪支店' }),
    ];
    expect(filterSites(items, { keyword: '本社' }).map((s) => s.id)).toEqual(['a']);
  });

  it('状態で絞り込む', () => {
    const items = [
      fixture({ id: asSiteId('a'), status: 'active' }),
      fixture({ id: asSiteId('b'), status: 'suspended' }),
    ];
    const filter: SiteListFilter = { status: 'suspended' as SiteStatus };
    expect(filterSites(items, filter).map((s) => s.id)).toEqual(['b']);
  });
});

describe('sitesToCsv: 拠点一覧 CSV 変換', () => {
  it('ヘッダ行 + データ行を出力する', () => {
    const csv = sitesToCsv([fixture()]);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('拠点名,状態,端末数,オンライン端末数');
    expect(lines[1]).toBe('本社受付,有効,2,1');
  });
});
