/**
 * kiosk 向け機能フラグ enforcement ゲートのテスト (#290 item4)。
 *
 * - 既定テナントスコープ（resolveDefaultScope と同じ default-scope）でフラグを解決すること
 * - レコード未作成は既定値（有効）＝ fail-open
 * - ストア障害時も fail-open（kiosk は可用性優先。フラグ取得不能で受付を止めない）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getTenantFeatureFlagRecord = vi.fn();

vi.mock('@/lib/platform/feature-flag-store', () => ({
  getTenantFeatureFlagRecord: (...a: unknown[]) => getTenantFeatureFlagRecord(...a),
}));
vi.mock('@/lib/tenant/default-scope', () => ({
  defaultTenantIdFrom: () => 'internal',
}));

import { isKioskFeatureEnabled } from './feature-flag-gate';

beforeEach(() => {
  vi.clearAllMocks();
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
});
