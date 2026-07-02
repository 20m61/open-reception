/**
 * 管理ダッシュボード集約 API のテスト (issue #86 / #261)。
 *
 * #261 の要点: 端末稼働は enabled フラグ（旧 summarizeDevices(listKiosks)）ではなく、
 * platform オブザーバビリティと **同一の共有関数 summarizeDeviceFleet**（kiosk/Device union の
 * 実 heartbeat 死活）から供給される。surface 間で online 数が食い違わないこと（AC2）の
 * dashboard 側配線を検証する。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FleetSummary } from '@/domain/tenant/device-liveness';

const listReceptionLogs = vi.fn();
const loadUsage = vi.fn();
const loadCostEstimate = vi.fn();
const summarizeDeviceFleet = vi.fn<() => Promise<FleetSummary>>();

vi.mock('@/lib/data-stores/reception-log-store', () => ({
  listReceptionLogs: () => listReceptionLogs(),
}));
vi.mock('@/lib/usage/usage-data', () => ({
  loadUsage: () => loadUsage(),
  loadCostEstimate: () => loadCostEstimate(),
}));
vi.mock('@/lib/tenant/device-fleet', () => ({
  summarizeDeviceFleet: (...a: unknown[]) => summarizeDeviceFleet(...(a as [])),
}));

import { GET } from './route';

const FLEET: FleetSummary = { total: 3, online: 2, offline: 1, maintenance: 1, disabled: 2 };

beforeEach(() => {
  vi.clearAllMocks();
  listReceptionLogs.mockResolvedValue([]);
  loadUsage.mockResolvedValue({ current: { receptions: 5 } });
  loadCostEstimate.mockResolvedValue({
    estimatedSoFar: 100,
    projectedMonthEnd: 300,
    currency: 'JPY',
  });
  summarizeDeviceFleet.mockResolvedValue(FLEET);
});

describe('GET /api/admin/dashboard (#261 端末実死活)', () => {
  it('端末稼働は共有の実死活集計（summarizeDeviceFleet）をそのまま返す', async () => {
    const body = await (await GET()).json();
    expect(summarizeDeviceFleet).toHaveBeenCalledTimes(1);
    expect(body.devices).toEqual(FLEET);
  });

  it('稼働可能端末が全台オフラインなら status=critical（実死活由来の異常検知）', async () => {
    summarizeDeviceFleet.mockResolvedValue({
      total: 2,
      online: 0,
      offline: 2,
      maintenance: 0,
      disabled: 0,
    });
    const body = await (await GET()).json();
    expect(body.status).toBe('critical');
  });

  it('利用量/コスト概況を含める（既存 #86 挙動の回帰確認）', async () => {
    const body = await (await GET()).json();
    expect(body.usageCost).toEqual({
      receptionsThisMonth: 5,
      estimatedSoFar: 100,
      projectedMonthEnd: 300,
      currency: 'JPY',
    });
  });
});
