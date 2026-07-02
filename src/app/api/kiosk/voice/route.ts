import { NextResponse } from 'next/server';
import { isKioskFeatureEnabled } from '@/lib/platform/feature-flag-gate';
import { getVoiceSettings } from '@/lib/voice/voice-store';

/**
 * GET /api/kiosk/voice — 受付端末向けの音声設定・案内文言 (issue #28)。
 * 秘匿情報は無く、案内文言と音声パラメータを公開する。
 *
 * #290 item4: 機能フラグ `voiceSynthesis` が無効なテナント（既定スコープ）では、応答スキーマを
 * 保ったまま ttsEnabled を強制 false にする（クライアントは ttsEnabled で発話可否を分岐する）。
 * 案内文言・STT はフラグの対象外なので維持する。
 */
export async function GET(): Promise<NextResponse> {
  const [settings, voiceSynthesisEnabled] = await Promise.all([
    getVoiceSettings(),
    isKioskFeatureEnabled('voiceSynthesis'),
  ]);
  if (!voiceSynthesisEnabled) {
    settings.ttsEnabled = false;
  }
  return NextResponse.json(settings);
}
