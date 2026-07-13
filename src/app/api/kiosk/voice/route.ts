import { NextResponse } from 'next/server';
import { isKioskFeatureEnabled } from '@/lib/platform/feature-flag-gate';
import { requireKioskSession } from '@/lib/kiosk/session-guard';
import { getVoiceSettings } from '@/lib/voice/voice-store';

/**
 * GET /api/kiosk/voice — 受付端末向けの音声設定・案内文言 (issue #28)。
 * 秘匿情報は無く、案内文言と音声パラメータを公開する。
 *
 * #290: 機能フラグ `voiceSynthesis` が無効なテナントでは、応答スキーマを保ったまま ttsEnabled を
 * 強制 false にする（クライアントは ttsEnabled で発話可否を分岐する）。案内文言・STT はフラグの
 * 対象外なので維持する。テナントは kiosk セッションの kioskId から解決する（未セッション時は
 * 既定テナント。フラグ判定のみに使い、可用性優先で session 必須にはしない）。
 */
export async function GET(): Promise<NextResponse> {
  const session = await requireKioskSession();
  const [settings, voiceSynthesisEnabled] = await Promise.all([
    getVoiceSettings(),
    isKioskFeatureEnabled('voiceSynthesis', session?.kioskId),
  ]);
  if (!voiceSynthesisEnabled) {
    settings.ttsEnabled = false;
  }
  return NextResponse.json(settings);
}
