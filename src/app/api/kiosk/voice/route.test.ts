/**
 * GET /api/kiosk/voice のテスト (#290 item4)。
 * voiceSynthesis フラグが無効なテナント（既定スコープ）では、応答スキーマを保ったまま
 * ttsEnabled を強制 false にする（クライアント KioskFlow は ttsEnabled で発話可否を分岐する）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getVoiceSettings = vi.fn();
const isKioskFeatureEnabled = vi.fn();
const requireKioskSession = vi.fn();

vi.mock('@/lib/voice/voice-store', () => ({
  getVoiceSettings: (...a: unknown[]) => getVoiceSettings(...a),
}));
vi.mock('@/lib/platform/feature-flag-gate', () => ({
  isKioskFeatureEnabled: (...a: unknown[]) => isKioskFeatureEnabled(...a),
}));
vi.mock('@/lib/kiosk/session-guard', () => ({
  requireKioskSession: () => requireKioskSession(),
}));

import { GET } from './route';

const settings = {
  ttsEnabled: true,
  sttEnabled: true,
  rate: 1,
  volume: 1,
  language: 'ja-JP',
  guidanceIdle: 'ようこそ',
};

beforeEach(() => {
  vi.clearAllMocks();
  getVoiceSettings.mockResolvedValue({ ...settings });
  isKioskFeatureEnabled.mockResolvedValue(true);
  requireKioskSession.mockResolvedValue({ kioskId: 'kiosk-1' });
});

describe('GET /api/kiosk/voice (#290)', () => {
  it('voiceSynthesis 有効時は音声設定をそのまま返す（フラグはセッション端末のテナントで判定）', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(settings);
    expect(isKioskFeatureEnabled).toHaveBeenCalledWith('voiceSynthesis', 'kiosk-1');
  });

  it('未セッション時は kioskId 未指定でフラグを判定する（既定テナント・後方互換）', async () => {
    requireKioskSession.mockResolvedValue(null);
    await GET();
    expect(isKioskFeatureEnabled).toHaveBeenCalledWith('voiceSynthesis', undefined);
  });

  it('voiceSynthesis 無効時は ttsEnabled を強制 false にする（他フィールドは維持）', async () => {
    isKioskFeatureEnabled.mockResolvedValue(false);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    // 音声合成のみ止める。案内文言や STT はフラグの対象外なので維持する。
    expect(body).toEqual({ ...settings, ttsEnabled: false });
  });
});
