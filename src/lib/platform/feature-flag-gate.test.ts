/**
 * kiosk 向け機能フラグ enforcement ゲートのテスト (#290 item4)。
 *
 * - 既定テナントスコープ（resolveDefaultScope と同じ default-scope）でフラグを解決すること
 * - レコード未作成は既定値（有効）＝ fail-open
 * - ストア障害時も fail-open（kiosk は可用性優先。フラグ取得不能で受付を止めない）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getTenantFeatureFlagRecord = vi.fn();
const findDeviceById = vi.fn();

vi.mock('@/lib/platform/feature-flag-store', () => ({
  getTenantFeatureFlagRecord: (...a: unknown[]) => getTenantFeatureFlagRecord(...a),
}));
vi.mock('@/lib/tenant/default-scope', () => ({
  defaultTenantIdFrom: () => 'internal',
}));
vi.mock('@/lib/tenant/store', () => ({
  getTenantStore: () => ({ devices: { findDeviceById: (...a: unknown[]) => findDeviceById(...a) } }),
}));

import { isKioskFeatureEnabled } from './feature-flag-gate';

beforeEach(() => {
  vi.clearAllMocks();
  findDeviceById.mockResolvedValue(undefined);
});

describe('isKioskFeatureEnabled (#290 item4)', () => {
  it('既定テナント ID でフラグレコードを引く', async () => {
    getTenantFeatureFlagRecord.mockResolvedValue(undefined);
    await isKioskFeatureEnabled('voiceSynthesis');
    expect(getTenantFeatureFlagRecord).toHaveBeenCalledWith('internal');
  });

  it('レコード未作成なら既定値（有効）を返す（fail-open）', async () => {
    getTenantFeatureFlagRecord.mockResolvedValue(undefined);
    await expect(isKioskFeatureEnabled('voiceSynthesis')).resolves.toBe(true);
    await expect(isKioskFeatureEnabled('avatarReception')).resolves.toBe(true);
  });

  it('無効化されたフラグは false を返す', async () => {
    getTenantFeatureFlagRecord.mockResolvedValue({
      id: 'internal',
      flags: { voiceSynthesis: false },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await expect(isKioskFeatureEnabled('voiceSynthesis')).resolves.toBe(false);
    // 上書きされていないキーは既定値のまま。
    await expect(isKioskFeatureEnabled('avatarReception')).resolves.toBe(true);
  });

  it('ストア障害時は有効扱い（fail-open: フラグ取得不能で受付を止めない）', async () => {
    getTenantFeatureFlagRecord.mockRejectedValue(new Error('backend down'));
    await expect(isKioskFeatureEnabled('voiceSynthesis')).resolves.toBe(true);
    await expect(isKioskFeatureEnabled('avatarReception')).resolves.toBe(true);
  });

  it('kioskId 未指定時はレジストリを引かず既定テナントで解決する（後方互換）', async () => {
    getTenantFeatureFlagRecord.mockResolvedValue(undefined);
    await isKioskFeatureEnabled('voiceSynthesis');
    expect(findDeviceById).not.toHaveBeenCalled();
    expect(getTenantFeatureFlagRecord).toHaveBeenCalledWith('internal');
  });
});

describe('isKioskFeatureEnabled — テナント別 enforcement（kiosk→tenant 写像, #290 残項目）', () => {
  it('kioskId が端末に一致するとその端末のテナントでフラグを引く', async () => {
    findDeviceById.mockResolvedValue({ id: 'kiosk-acme', tenantId: 'acme', siteId: 'acme-hq' });
    getTenantFeatureFlagRecord.mockResolvedValue(undefined);
    await isKioskFeatureEnabled('voiceSynthesis', 'kiosk-acme');
    expect(findDeviceById).toHaveBeenCalledWith('kiosk-acme');
    expect(getTenantFeatureFlagRecord).toHaveBeenCalledWith('acme');
  });

  it('その端末のテナントで無効化されたフラグは false（別テナントの無効化に影響されない）', async () => {
    findDeviceById.mockResolvedValue({ id: 'kiosk-acme', tenantId: 'acme', siteId: 'acme-hq' });
    getTenantFeatureFlagRecord.mockResolvedValue({
      id: 'acme',
      flags: { voiceSynthesis: false },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await expect(isKioskFeatureEnabled('voiceSynthesis', 'kiosk-acme')).resolves.toBe(false);
    await expect(isKioskFeatureEnabled('avatarReception', 'kiosk-acme')).resolves.toBe(true);
  });

  it('前後空白を除いて端末を解決する', async () => {
    findDeviceById.mockResolvedValue({ id: 'kiosk-acme', tenantId: 'acme', siteId: 'acme-hq' });
    getTenantFeatureFlagRecord.mockResolvedValue(undefined);
    await isKioskFeatureEnabled('voiceSynthesis', '  kiosk-acme  ');
    expect(findDeviceById).toHaveBeenCalledWith('kiosk-acme');
    expect(getTenantFeatureFlagRecord).toHaveBeenCalledWith('acme');
  });

  it('未登録 kioskId は既定テナントへフォールバックする', async () => {
    findDeviceById.mockResolvedValue(undefined);
    getTenantFeatureFlagRecord.mockResolvedValue(undefined);
    await isKioskFeatureEnabled('voiceSynthesis', 'kiosk-unknown');
    expect(getTenantFeatureFlagRecord).toHaveBeenCalledWith('internal');
  });

  it('空・空白のみの kioskId はレジストリを引かず既定テナント', async () => {
    getTenantFeatureFlagRecord.mockResolvedValue(undefined);
    await isKioskFeatureEnabled('voiceSynthesis', '   ');
    expect(findDeviceById).not.toHaveBeenCalled();
    expect(getTenantFeatureFlagRecord).toHaveBeenCalledWith('internal');
  });
});
