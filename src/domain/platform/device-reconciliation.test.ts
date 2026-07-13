/**
 * 端末レジストリ整合（reconcileDeviceRegistry）の単体テスト (#290 item2 データ修復 dry-run)。
 *
 * flat な kiosk-store（#18）と tenant 境界を持つ Device レジストリ（#87）の drift を検出する純関数。
 * mutation はしない（dry-run のプラン算出のみ）。
 *   - adopt:      kiosk-store にあり Device が無い → adoptKiosk 相当で新規作成される
 *   - syncStatus: id 一致だが status 不一致 → syncKioskState 相当で status 更新される
 *   - deviceOnly: Device のみ（kiosk-store に無い）→ 情報提供のみ（自動修復対象外・drift に数えない）
 */
import { describe, expect, it } from 'vitest';
import { asDeviceId, asSiteId, asTenantId, type Device } from '@/domain/tenant/types';
import type { Kiosk } from '@/domain/kiosk/types';
import { reconcileDeviceRegistry } from './device-reconciliation';

const kiosk = (id: string, enabled: boolean): Kiosk => ({ id, displayName: id, enabled });

const device = (id: string, status: Device['status'] = 'active'): Device => ({
  id: asDeviceId(id),
  tenantId: asTenantId('internal'),
  siteId: asSiteId('default-site'),
  name: id,
  status,
  maintenance: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('reconcileDeviceRegistry (#290 item2)', () => {
  it('kiosk-store のみの端末は adopt（enabled→active / disabled→revoked）', () => {
    const plan = reconcileDeviceRegistry([kiosk('kiosk-a', true), kiosk('kiosk-b', false)], []);
    expect(plan.adopt).toEqual([
      { id: 'kiosk-a', action: 'adopt', kioskEnabled: true, targetStatus: 'active' },
      { id: 'kiosk-b', action: 'adopt', kioskEnabled: false, targetStatus: 'revoked' },
    ]);
    expect(plan.syncStatus).toEqual([]);
    expect(plan.deviceOnly).toEqual([]);
    expect(plan.driftCount).toBe(2);
  });

  it('id 一致で status 不一致は syncStatus（両方向）', () => {
    const plan = reconcileDeviceRegistry(
      [kiosk('kiosk-a', false), kiosk('kiosk-b', true)],
      [device('kiosk-a', 'active'), device('kiosk-b', 'revoked')],
    );
    expect(plan.syncStatus).toEqual([
      { id: 'kiosk-a', action: 'sync_status', kioskEnabled: false, deviceStatus: 'active', targetStatus: 'revoked' },
      { id: 'kiosk-b', action: 'sync_status', kioskEnabled: true, deviceStatus: 'revoked', targetStatus: 'active' },
    ]);
    expect(plan.adopt).toEqual([]);
    expect(plan.driftCount).toBe(2);
  });

  it('id 一致で status 一致は drift なし（エントリを作らない）', () => {
    const plan = reconcileDeviceRegistry([kiosk('kiosk-a', true)], [device('kiosk-a', 'active')]);
    expect(plan.adopt).toEqual([]);
    expect(plan.syncStatus).toEqual([]);
    expect(plan.deviceOnly).toEqual([]);
    expect(plan.driftCount).toBe(0);
  });

  it('Device のみ（kiosk-store に無い）は deviceOnly（情報のみ・drift に数えない）', () => {
    const plan = reconcileDeviceRegistry([], [device('device-uuid-1', 'active')]);
    expect(plan.deviceOnly).toEqual([{ id: 'device-uuid-1', action: 'device_only', deviceStatus: 'active' }]);
    expect(plan.driftCount).toBe(0);
  });

  it('走査総数（kioskCount / deviceCount）を返す', () => {
    const plan = reconcileDeviceRegistry(
      [kiosk('kiosk-a', true), kiosk('kiosk-b', true)],
      [device('kiosk-a', 'active'), device('device-x', 'active')],
    );
    expect(plan.kioskCount).toBe(2);
    expect(plan.deviceCount).toBe(2);
    // kiosk-a は一致、kiosk-b は adopt、device-x は deviceOnly。
    expect(plan.adopt.map((a) => a.id)).toEqual(['kiosk-b']);
    expect(plan.deviceOnly.map((d) => d.id)).toEqual(['device-x']);
    expect(plan.driftCount).toBe(1);
  });

  it('空レジストリは全空・drift 0', () => {
    const plan = reconcileDeviceRegistry([], []);
    expect(plan).toEqual({
      adopt: [],
      syncStatus: [],
      deviceOnly: [],
      driftCount: 0,
      kioskCount: 0,
      deviceCount: 0,
    });
  });
});
