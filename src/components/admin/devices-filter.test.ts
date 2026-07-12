import { describe, expect, it } from 'vitest';
import { asDeviceId, asSiteId, asTenantId } from '@/domain/tenant/types';
import type { DeviceView } from '@/lib/tenant/device-service';
import { filterDevices, devicesToCsv, type DeviceListFilter } from './devices-filter';

function fixture(overrides: Partial<DeviceView> = {}): DeviceView {
  return {
    id: asDeviceId('device-1'),
    tenantId: asTenantId('internal'),
    siteId: asSiteId('default'),
    name: '受付端末A',
    status: 'active',
    location: '1F エントランス',
    kind: 'kiosk',
    connectivity: 'online',
    tokenRegistered: true,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('filterDevices: 受付端末一覧の検索・フィルタ純関数 (issue #330 item2 残増分)', () => {
  it('未指定条件は全件を返す', () => {
    const items = [fixture(), fixture({ id: asDeviceId('device-2') })];
    expect(filterDevices(items, {})).toHaveLength(2);
  });

  it('端末名・設置場所の部分一致（大文字小文字を無視）で絞り込む', () => {
    const items = [
      fixture({ id: asDeviceId('a'), name: '受付端末A', location: '1F エントランス' }),
      fixture({ id: asDeviceId('b'), name: '受付端末B', location: '2F 応接' }),
    ];
    expect(filterDevices(items, { keyword: 'エントランス' }).map((d) => d.id)).toEqual(['a']);
    expect(filterDevices(items, { keyword: '端末b' }).map((d) => d.id)).toEqual(['b']);
  });

  it('稼働状態で絞り込む', () => {
    const items = [
      fixture({ id: asDeviceId('a'), connectivity: 'online' }),
      fixture({ id: asDeviceId('b'), connectivity: 'offline' }),
    ];
    const filter: DeviceListFilter = { connectivity: 'offline' };
    expect(filterDevices(items, filter).map((d) => d.id)).toEqual(['b']);
  });

  it('種別で絞り込む（未指定は kiosk 扱い）', () => {
    const items = [
      fixture({ id: asDeviceId('a'), kind: undefined }),
      fixture({ id: asDeviceId('b'), kind: 'tablet' }),
    ];
    expect(filterDevices(items, { kind: 'kiosk' }).map((d) => d.id)).toEqual(['a']);
    expect(filterDevices(items, { kind: 'tablet' }).map((d) => d.id)).toEqual(['b']);
  });
});

describe('devicesToCsv: 受付端末一覧 CSV 変換（token 平文を含まない）', () => {
  it('ヘッダ行 + データ行を出力し token 平文を含まない', () => {
    const csv = devicesToCsv([fixture()]);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('端末名,設置場所,種別,稼働状態,最終接続,token');
    expect(lines[1]).toContain('登録済み');
  });
});
