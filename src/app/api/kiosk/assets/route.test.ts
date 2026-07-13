/**
 * GET /api/kiosk/assets のテスト (#290 item4)。
 * avatarReception フラグが無効なテナント（既定スコープ）では、アバター関連 URL（vrmUrl /
 * fallbackImageUrl）を応答から落とす。backgroundUrl はアバター機能ではないため維持する。
 * クライアント KioskFlow は vrmUrl / fallbackImageUrl 未指定でアバター無しにフォールバックする。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getKioskAssets = vi.fn();
const isKioskFeatureEnabled = vi.fn();
const requireKioskSession = vi.fn();

vi.mock('@/lib/assets/asset-store', () => ({
  getKioskAssets: (...a: unknown[]) => getKioskAssets(...a),
}));
vi.mock('@/lib/platform/feature-flag-gate', () => ({
  isKioskFeatureEnabled: (...a: unknown[]) => isKioskFeatureEnabled(...a),
}));
vi.mock('@/lib/kiosk/session-guard', () => ({
  requireKioskSession: () => requireKioskSession(),
}));

import { GET } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  getKioskAssets.mockResolvedValue({
    backgroundUrl: 'https://example.com/bg.jpg',
    fallbackImageUrl: 'https://example.com/avatar.png',
    vrmUrl: 'https://example.com/model.vrm',
  });
  isKioskFeatureEnabled.mockResolvedValue(true);
  requireKioskSession.mockResolvedValue({ kioskId: 'kiosk-1' });
});

describe('GET /api/kiosk/assets (#290)', () => {
  it('avatarReception 有効時はアクティブアセットをそのまま返す（フラグはセッション端末のテナントで判定）', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      backgroundUrl: 'https://example.com/bg.jpg',
      fallbackImageUrl: 'https://example.com/avatar.png',
      vrmUrl: 'https://example.com/model.vrm',
    });
    expect(isKioskFeatureEnabled).toHaveBeenCalledWith('avatarReception', 'kiosk-1');
  });

  it('未セッション時は kioskId 未指定でフラグを判定する（既定テナント・後方互換）', async () => {
    requireKioskSession.mockResolvedValue(null);
    await GET();
    expect(isKioskFeatureEnabled).toHaveBeenCalledWith('avatarReception', undefined);
  });

  it('avatarReception 無効時はアバター関連 URL を落とし、背景は維持する', async () => {
    isKioskFeatureEnabled.mockResolvedValue(false);
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      backgroundUrl: 'https://example.com/bg.jpg',
    });
  });
});
