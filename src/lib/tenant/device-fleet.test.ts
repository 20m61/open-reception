/**
 * 端末死活の横断集計（device-fleet）のテスト (issue #261)。
 *
 * 検証の柱:
 *   - Device / kiosk 両レジストリの union を 1 つの共有関数として返す（AC1/AC2 の supply 側）。
 *   - TTL キャッシュで毎リクエストのフルスキャンをしない（AC3、#260 撤回理由 3）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asDeviceId, asSiteId, asTenantId, type Device } from '@/domain/tenant/types';

const listAllDevices = vi.fn<() => Promise<Device[]>>();
const listKiosks = vi.fn();

vi.mock('@/lib/tenant/store', () => ({
  getTenantStore: () => ({ devices: { listAllDevices: () => listAllDevices() } }),
}));
vi.mock('@/lib/kiosk/kiosk-store', () => ({
  listKiosks: () => listKiosks(),
}));

import {
  DEVICE_FLEET_CACHE_TTL_MS,
  summarizeDeviceFleet,
  __resetDeviceFleetCache,
} from './device-fleet';

const NOW = new Date('2026-07-02T09:00:00.000Z');

const device = (id: string, over: Partial<Device> = {}): Device => ({
  id: asDeviceId(id),
  tenantId: asTenantId('internal'),
  siteId: asSiteId('default-site'),
  name: id,
  status: 'active',
  maintenance: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetDeviceFleetCache();
  listAllDevices.mockResolvedValue([]);
  listKiosks.mockResolvedValue([]);
});

describe('summarizeDeviceFleet (#261)', () => {
  it('Device / kiosk 両レジストリの union を集計する（分母は稼働可能端末のみ）', async () => {
    listAllDevices.mockResolvedValue([
      device('on', { lastSeenAt: NOW.toISOString() }),
      device('mnt', { maintenance: true }),
    ]);
    listKiosks.mockResolvedValue([
      { id: 'on', displayName: '対応済', enabled: true }, // Device と id 一致 → 二重に数えない
      { id: 'legacy', displayName: '旧のみ', enabled: true }, // kiosk のみ → offline
      { id: 'gone', displayName: '失効', enabled: false }, // kiosk のみ失効 → disabled 別掲
    ]);
    expect(await summarizeDeviceFleet(NOW)).toEqual({
      total: 2,
      online: 1,
      offline: 1,
      maintenance: 1,
      disabled: 1,
    });
  });

  it('TTL 内の再呼び出しはストアを再走査しない（境界化, AC3）', async () => {
    listAllDevices.mockResolvedValue([device('d1')]);
    const first = await summarizeDeviceFleet(NOW);
    const second = await summarizeDeviceFleet(new Date(NOW.getTime() + 1_000));
    expect(second).toEqual(first);
    expect(listAllDevices).toHaveBeenCalledTimes(1);
    expect(listKiosks).toHaveBeenCalledTimes(1);
  });

  it('TTL を過ぎたら再集計する（stale を出し続けない）', async () => {
    listAllDevices.mockResolvedValue([]);
    await summarizeDeviceFleet(NOW);
    listAllDevices.mockResolvedValue([device('d1', { lastSeenAt: NOW.toISOString() })]);
    const later = new Date(NOW.getTime() + DEVICE_FLEET_CACHE_TTL_MS + 1);
    const refreshed = await summarizeDeviceFleet(later);
    expect(listAllDevices).toHaveBeenCalledTimes(2);
    // 窓内 heartbeat (age = TTL+1ms < 5 分) なので online。
    expect(refreshed.online).toBe(1);
  });

  it('時計が巻き戻った場合はキャッシュを信用せず再集計する', async () => {
    await summarizeDeviceFleet(NOW);
    await summarizeDeviceFleet(new Date(NOW.getTime() - 60_000));
    expect(listAllDevices).toHaveBeenCalledTimes(2);
  });

  it('並行リクエストは in-flight の集計を共有し、走査を多重発火しない（stampede 防止）', async () => {
    let release: (v: Device[]) => void = () => {};
    listAllDevices.mockReturnValue(new Promise<Device[]>((r) => (release = r)));
    const p1 = summarizeDeviceFleet(NOW);
    const p2 = summarizeDeviceFleet(new Date(NOW.getTime() + 1_000)); // 解決前の並行呼び出し
    release([device('d1', { lastSeenAt: NOW.toISOString() })]);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
    expect(listAllDevices).toHaveBeenCalledTimes(1);
  });

  it('取得失敗は握り潰さず伝播する（偽の健全表示を出さない）', async () => {
    listAllDevices.mockRejectedValue(new Error('backend down'));
    await expect(summarizeDeviceFleet(NOW)).rejects.toThrow('backend down');
  });

  it('失敗はキャッシュしない（次のリクエストで再試行して復帰する）', async () => {
    listAllDevices.mockRejectedValueOnce(new Error('backend down'));
    await expect(summarizeDeviceFleet(NOW)).rejects.toThrow('backend down');
    listAllDevices.mockResolvedValue([device('d1', { lastSeenAt: NOW.toISOString() })]);
    const recovered = await summarizeDeviceFleet(new Date(NOW.getTime() + 1_000));
    expect(recovered.online).toBe(1);
  });
});
