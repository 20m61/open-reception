import { NextResponse } from 'next/server';
import { applyVoiceEvent, voiceStateToRouteResult, type VonageCallStatus } from '@/domain/call/voice-call-state';
import { rejectWebhook, verifyRequest } from '@/lib/routing/vonage-webhook-route';

/**
 * POST /api/providers/vonage/events — 通話ステータスの webhook (issue #4 MVP 1)。
 *
 * 受け取ったステータスを状態機械へ通し、取次結果が確定したかだけを判断する。
 * **取次を次の手へ進めるのは Inc D（VonageVoiceProvider の配線）**。ここでは相関の
 * 状態遷移までに留め、確定していない段階では何もしない。
 *
 * 応答は常に 200/403 の 2 値。処理できたかを本文で語らない（存在を漏らさない）。
 */
const KNOWN_STATUSES: readonly VonageCallStatus[] = [
  'ringing',
  'answered',
  'busy',
  'unanswered',
  'timeout',
  'rejected',
  'failed',
  'completed',
];

function readStatus(rawBody: string): VonageCallStatus | undefined {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const status = (parsed as Record<string, unknown>).status;
    return KNOWN_STATUSES.find((s) => s === status);
  } catch {
    return undefined;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const { verified, rawBody } = await verifyRequest(request);
  if (!verified.ok) return rejectWebhook();

  const status = readStatus(rawBody);
  // 未知のステータスは黙って受け取る（Vonage 側の追加で 4xx を返すと再送が走り続ける）。
  if (status === undefined) return new NextResponse(null, { status: 204 });

  const next = applyVoiceEvent('queued', { kind: 'status', status });
  const result = voiceStateToRouteResult(next);
  // 進行中（結果未確定）なら何もしない。確定の反映は Inc D で取次へ繋ぐ。
  void result;
  return new NextResponse(null, { status: 204 });
}
