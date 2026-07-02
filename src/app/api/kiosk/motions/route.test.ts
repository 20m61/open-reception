/**
 * GET /api/kiosk/motions のテスト (#290 item4)。
 * avatarReception フラグが無効なテナント（既定スコープ）では、応答スキーマ
 * `{ motions, defaultUrl? }` を保ったまま空のモーション集合を返す（クライアント KioskFlow は
 * motions 空 = アバター静止/フォールバックで受付を継続する）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getKioskMotions = vi.fn();
const isKioskFeatureEnabled = vi.fn();

vi.mock('@/lib/motion/motion-store', () => ({
  getKioskMotions: (...a: unknown[]) => getKioskMotions(...a),
}));
vi.mock('@/lib/platform/feature-flag-gate', () => ({
  isKioskFeatureEnabled: (...a: unknown[]) => isKioskFeatureEnabled(...a),
}));

import { GET } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  getKioskMotions.mockResolvedValue({
    motions: { idle: 'https://example.com/idle.vrma' },
    defaultUrl: 'https://example.com/default.vrma',
  });
  isKioskFeatureEnabled.mockResolvedValue(true);
});

describe('GET /api/kiosk/motions (#290 item4)', () => {
  it('avatarReception 有効時はモーション設定をそのまま返す', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      motions: { idle: 'https://example.com/idle.vrma' },
      defaultUrl: 'https://example.com/default.vrma',
    });
    expect(isKioskFeatureEnabled).toHaveBeenCalledWith('avatarReception');
  });

  it('avatarReception 無効時は空のモーション集合を返す（ストアは引かない）', async () => {
    isKioskFeatureEnabled.mockResolvedValue(false);
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ motions: {} });
    expect(getKioskMotions).not.toHaveBeenCalled();
  });
});
