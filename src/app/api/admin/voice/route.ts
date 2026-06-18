import { NextResponse } from 'next/server';
import { getVoiceSettings, updateVoiceSettings } from '@/lib/voice/voice-store';
import { readJson } from '@/lib/mock-backend/result-http';
import { appendAdminAudit } from '@/lib/mock-backend/reception-log-store';

/**
 * GET/PUT /api/admin/voice — 音声設定の取得・更新 (issue #28)。
 * NOTE: 認証・認可は middleware（#24）で付与済み。
 */
export function GET(): NextResponse {
  return NextResponse.json(getVoiceSettings());
}

export async function PUT(request: Request): Promise<NextResponse> {
  const updated = updateVoiceSettings(await readJson(request));
  appendAdminAudit('voice.updated', { type: 'voice' }, {
    ttsEnabled: String(updated.ttsEnabled),
    sttEnabled: String(updated.sttEnabled),
  });
  return NextResponse.json(updated);
}
