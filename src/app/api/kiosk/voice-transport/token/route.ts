import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { KIOSK_COOKIE, readKioskSession } from '@/lib/auth/kiosk';
import { getReception } from '@/lib/data-stores/reception-store';
import { resolveKioskScope } from '@/lib/voice-transport/kiosk-scope';
import { issueVoiceTransportToken } from '@/lib/voice-transport/token';
import { DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG } from '@/domain/voice-transport/types';
import { readJson } from '@/lib/data-stores/result-http';

/**
 * POST /api/kiosk/voice-transport/token — 音声 Transport 接続用の短命トークンを発行する
 * (issue #369)。
 *
 * `/api/kiosk/receptions/:id/token`（Vonage publisher token）と同じ認可の流儀:
 *  - 有効な kiosk セッション必須（端末からの要求であることを担保）。
 *  - 対象 reception を作成した端末（reception.kioskId）からの要求に限定する。
 *
 * claims の tenantId/siteId/kioskId は**すべてサーバ権威**で決める（kioskId はセッション、
 * tenantId/siteId は device レジストリから解決）。リクエスト body に同名フィールドが
 * 含まれていても無視する（クライアント詐称防止）。
 */
export async function POST(request: Request): Promise<NextResponse> {
  const kioskCookie = (await cookies()).get(KIOSK_COOKIE)?.value;
  const session = await readKioskSession(kioskCookie);
  if (!session) {
    return NextResponse.json({ error: 'forbidden', message: 'kiosk session required' }, { status: 403 });
  }

  const body = (await readJson(request)) as { receptionSessionId?: unknown } | null;
  const receptionSessionId = typeof body?.receptionSessionId === 'string' ? body.receptionSessionId : '';
  if (!receptionSessionId) {
    return NextResponse.json(
      { error: 'invalid_input', message: 'receptionSessionId is required' },
      { status: 400 },
    );
  }

  const found = await getReception(receptionSessionId);
  if (!found.ok) {
    return NextResponse.json({ error: 'not_found', message: 'reception not found' }, { status: 404 });
  }
  if (found.value.kioskId !== session.kioskId) {
    return NextResponse.json(
      { error: 'forbidden', message: 'reception belongs to another kiosk' },
      { status: 403 },
    );
  }

  const scope = await resolveKioskScope(session.kioskId);
  const { token, expiresAt } = await issueVoiceTransportToken({
    tenantId: scope.tenantId,
    siteId: scope.siteId,
    kioskId: session.kioskId,
    receptionSessionId,
    jti: randomUUID(),
  });

  return NextResponse.json({ token, expiresAt, audioConfig: DEFAULT_VOICE_TRANSPORT_AUDIO_CONFIG });
}
