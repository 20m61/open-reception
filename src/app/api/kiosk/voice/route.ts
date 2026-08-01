import { NextResponse } from 'next/server';
import { isKioskFeatureEnabled } from '@/lib/platform/feature-flag-gate';
import { requireKioskSession } from '@/lib/kiosk/session-guard';
import { getVoiceSettings } from '@/lib/voice/voice-store';
import { defaultTenantIdFrom } from '@/lib/tenant/default-scope';

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
    // 旧・個別 API。端末セッションを要求しない公開経路なので既定テナント固定のまま
    // 据え置く（テナントを受け取る形にすると無認証で任意テナントの設定を引ける）。
    // 正規経路は GET /api/configuration/effective。撤去対象（#419 台帳 §9 B-03）。
    getVoiceSettings(defaultTenantIdFrom()),
    isKioskFeatureEnabled('voiceSynthesis', session?.kioskId),
  ]);
  if (!voiceSynthesisEnabled) {
    settings.ttsEnabled = false;
  }
  return NextResponse.json(settings);
}
