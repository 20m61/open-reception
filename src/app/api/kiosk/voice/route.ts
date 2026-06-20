import { NextResponse } from 'next/server';
import { getVoiceSettings } from '@/lib/voice/voice-store';

/**
 * GET /api/kiosk/voice — 受付端末向けの音声設定・案内文言 (issue #28)。
 * 秘匿情報は無く、案内文言と音声パラメータを公開する。
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(await getVoiceSettings());
}
