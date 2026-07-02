/**
 * 端末死活の横断集計（device-fleet）のテスト (issue #261 → #274/#284 境界クエリ恒久化)。
 *
 * 検証の柱:
 *   - Device / kiosk 両レジストリの union を 1 つの共有関数として返す（AC1/AC2 の supply 側）。
 *   - 横断集計は「テナント一覧起点 + テナント毎の境界クエリ」で行い、無境界の
 *     listAllDevices を使わない（#284 恒久化）。
 *   - TTL キャッシュで毎リクエストのフルスキャンをしない（AC3、#260 撤回理由 3）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asDeviceId, asSiteId, asTenantId, type Device, type Tenant } from '@/domain/tenant/types';

const listTenants = vi.fn<() => Promise<Tenant[]>>();
const listDevicesByTenant = vi.fn<(tenantId: string) => Promise<Device[]>>();
const listKiosks = vi.fn();

vi.mock('@/lib/tenant/store', () => ({
  getTenantStore: () => ({
    tenants: { listTenants: () => listTenants() },
    devices: { listDevicesByTenant: (t: string) => listDevicesByTenant(t) },
  }),
}));
vi.mock('@/lib/kiosk/kiosk-store', () => ({
  listKiosks: () => listKiosks(),
}));

import {
  DEVICE_FLEET_CACHE_TTL_MS,
  summarizeDeviceFleet,
  summarizeDeviceFleetForTenants,
  __resetDeviceFleetCache,
} from './device-fleet';

const NOW = new Date('2026-07-02T09:00:00.000Z');

const tenant = (id: string): Tenant => ({
  id: asTenantId(id),
  name: id,
  slug: id,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

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
  listTenants.mockResolvedValue([tenant('internal')]);
  listDevicesByTenant.mockResolvedValue([]);
  listKiosks.mockResolvedValue([]);
});

describe('summarizeDeviceFleet (#261/#284)', () => {
  it('Device / kiosk 両レジストリの union を集計する（分母は稼働可能端末のみ）', async () => {
    listDevicesByTenant.mockResolvedValue([
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

  it('テナント一覧起点でテナント毎の境界クエリを集約する（listAllDevices を使わない, #284）', async () => {
    listTenants.mockResolvedValue([tenant('t-a'), tenant('t-b')]);
    listDevicesByTenant.mockImplementation(async (tenantId) =>
      tenantId === 't-a'
        ? [device('a1', { tenantId: asTenantId('t-a'), lastSeenAt: NOW.toISOString() })]
        : [device('b1', { tenantId: asTenantId('t-b') })],
    );
    const summary = await summarizeDeviceFleet(NOW);
    // 両テナントの端末が漏れなく集計される（a1 online / b1 offline）。
    expect(summary).toEqual({ total: 2, online: 1, offline: 1, maintenance: 0, disabled: 0 });
    expect(listDevicesByTenant).toHaveBeenCalledTimes(2);
    expect(listDevicesByTenant).toHaveBeenCalledWith(asTenantId('t-a'));
    expect(listDevicesByTenant).toHaveBeenCalledWith(asTenantId('t-b'));
  });

  it('TTL 内の再呼び出しはストアを再走査しない（境界化, AC3）', async () => {
    listDevicesByTenant.mockResolvedValue([device('d1')]);
    const first = await summarizeDeviceFleet(NOW);
    const second = await summarizeDeviceFleet(new Date(NOW.getTime() + 1_000));
    expect(second).toEqual(first);
    expect(listTenants).toHaveBeenCalledTimes(1);
    expect(listDevicesByTenant).toHaveBeenCalledTimes(1);
    expect(listKiosks).toHaveBeenCalledTimes(1);
  });

  it('TTL を過ぎたら再集計する（stale を出し続けない）', async () => {
    listDevicesByTenant.mockResolvedValue([]);
    await summarizeDeviceFleet(NOW);
    listDevicesByTenant.mockResolvedValue([device('d1', { lastSeenAt: NOW.toISOString() })]);
    const later = new Date(NOW.getTime() + DEVICE_FLEET_CACHE_TTL_MS + 1);
    const refreshed = await summarizeDeviceFleet(later);
    expect(listDevicesByTenant).toHaveBeenCalledTimes(2);
    // 窓内 heartbeat (age = TTL+1ms < 5 分) なので online。
    expect(refreshed.online).toBe(1);
  });

  it('時計が巻き戻った場合はキャッシュを信用せず再集計する', async () => {
    await summarizeDeviceFleet(NOW);
    await summarizeDeviceFleet(new Date(NOW.getTime() - 60_000));
    expect(listTenants).toHaveBeenCalledTimes(2);
  });

  it('並行リクエストは in-flight の集計を共有し、走査を多重発火しない（stampede 防止）', async () => {
    let release: (v: Device[]) => void = () => {};
    listDevicesByTenant.mockReturnValue(new Promise<Device[]>((r) => (release = r)));
    const p1 = summarizeDeviceFleet(NOW);
    const p2 = summarizeDeviceFleet(new Date(NOW.getTime() + 1_000)); // 解決前の並行呼び出し
    release([device('d1', { lastSeenAt: NOW.toISOString() })]);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
    expect(listDevicesByTenant).toHaveBeenCalledTimes(1);
  });

  it('取得失敗は握り潰さず伝播する（偽の健全表示を出さない）', async () => {
    listDevicesByTenant.mockRejectedValue(new Error('backend down'));
    await expect(summarizeDeviceFleet(NOW)).rejects.toThrow('backend down');
  });

  it('失敗はキャッシュしない（次のリクエストで再試行して復帰する）', async () => {
    listDevicesByTenant.mockRejectedValueOnce(new Error('backend down'));
    await expect(summarizeDeviceFleet(NOW)).rejects.toThrow('backend down');
    listDevicesByTenant.mockResolvedValue([device('d1', { lastSeenAt: NOW.toISOString() })]);
    const recovered = await summarizeDeviceFleet(new Date(NOW.getTime() + 1_000));
    expect(recovered.online).toBe(1);
  });
});

describe('summarizeDeviceFleetForTenants (#284 item4: テナントスコープ集計)', () => {
  it('指定テナントの境界クエリのみ集計し、テナント一覧走査をしない', async () => {
    listDevicesByTenant.mockImplementation(async (tenantId) =>
      tenantId === 't-a'
        ? [device('a1', { tenantId: asTenantId('t-a'), lastSeenAt: NOW.toISOString() })]
        : [],
    );
    const summary = await summarizeDeviceFleetForTenants([asTenantId('t-a')], NOW);
    expect(summary).toEqual({ total: 1, online: 1, offline: 0, maintenance: 0, disabled: 0 });
    expect(listDevicesByTenant).toHaveBeenCalledTimes(1);
    expect(listDevicesByTenant).toHaveBeenCalledWith(asTenantId('t-a'));
    expect(listTenants).not.toHaveBeenCalled();
  });

  it('既定テナントを含むスコープでは kiosk レガシーレジストリを union する（既定運用の同値性）', async () => {
    listDevicesByTenant.mockResolvedValue([device('on', { lastSeenAt: NOW.toISOString() })]);
    listKiosks.mockResolvedValue([
      { id: 'on', displayName: '対応済', enabled: true }, // Device と id 一致 → 二重に数えない
      { id: 'legacy', displayName: '旧のみ', enabled: true }, // kiosk のみ → offline
    ]);
    const summary = await summarizeDeviceFleetForTenants([asTenantId('internal')], NOW);
    expect(summary).toEqual({ total: 2, online: 1, offline: 1, maintenance: 0, disabled: 0 });
  });

  it('既定テナント外のスコープでは kiosk（tenantId 非保持）を混入させない', async () => {
    listDevicesByTenant.mockResolvedValue([
      device('b1', { tenantId: asTenantId('t-b'), lastSeenAt: NOW.toISOString() }),
    ]);
    listKiosks.mockResolvedValue([{ id: 'legacy', displayName: '旧のみ', enabled: true }]);
    const summary = await summarizeDeviceFleetForTenants([asTenantId('t-b')], NOW);
    // kiosk 分（他テナントには属さない）が t-b の集計へ漏れない。
    expect(summary).toEqual({ total: 1, online: 1, offline: 0, maintenance: 0, disabled: 0 });
    expect(listKiosks).not.toHaveBeenCalled();
  });

  it('複数テナント割り当ての actor 向けに、各テナントの境界クエリを合算する', async () => {
    listDevicesByTenant.mockImplementation(async (tenantId) =>
      tenantId === 't-a'
        ? [device('a1', { tenantId: asTenantId('t-a'), lastSeenAt: NOW.toISOString() })]
        : [device('b1', { tenantId: asTenantId('t-b'), maintenance: true })],
    );
    const summary = await summarizeDeviceFleetForTenants([asTenantId('t-a'), asTenantId('t-b')], NOW);
    expect(summary).toEqual({ total: 1, online: 1, offline: 0, maintenance: 1, disabled: 0 });
    expect(listDevicesByTenant).toHaveBeenCalledTimes(2);
  });

  it('取得失敗は握り潰さず伝播する（偽の健全表示を出さない）', async () => {
    listDevicesByTenant.mockRejectedValue(new Error('backend down'));
    await expect(summarizeDeviceFleetForTenants([asTenantId('internal')], NOW)).rejects.toThrow(
      'backend down',
    );
  });
});
