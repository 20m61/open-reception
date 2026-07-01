import { NextResponse } from 'next/server';
import { getVoiceSettings, updateVoiceSettings } from '@/lib/voice/voice-store';
import { readJson } from '@/lib/data-stores/result-http';
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import {
  assertCanRead,
  assertCanWrite,
  defaultAdminTenantId,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';

/**
 * GET/PUT /api/admin/voice — 音声設定の取得・更新 (issue #28)。
 *
 * 認可（#91 inc2）: route 側で実 actor を解決し `requireActor` + `assertCanRead/Write`
 * で最終認可を行う（フロントで隠した操作でも 403）。
 */
export async function GET(): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanRead(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  return NextResponse.json(await getVoiceSettings());
}

export async function PUT(request: Request): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanWrite(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  const updated = await updateVoiceSettings(await readJson(request));
  await appendAdminAudit('voice.updated', { type: 'voice' }, {
    ttsEnabled: String(updated.ttsEnabled),
    sttEnabled: String(updated.sttEnabled),
  });
  return NextResponse.json(updated);
}
