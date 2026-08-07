import { NextResponse } from 'next/server';
import type { VonageCallStatus } from '@/domain/call/voice-call-state';
import { logWebhookRejection, rejectWebhook, verifyRequest } from '@/lib/routing/vonage-webhook-route';
import { applyVoiceEventToCorrelation } from '@/lib/routing/voice-event';

/**
 * POST /api/providers/vonage/events — 通話ステータスの webhook (issue #4 MVP 1)。
 *
 * 受け取ったステータスを状態機械へ通し、相関へ保存する（Inc D-2 で配線）。
 * 次の手の**発信**はまだ行わない（provider 選択＝実送信の停止境界。Inc D-2 項目 2）。
 * 発信できない以上、位置は動かさず通話状態だけを記録する。
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
  if (!verified.ok) {
    logWebhookRejection('events', verified.logOnly);
    return rejectWebhook();
  }

  const status = readStatus(rawBody);
  // 未知のステータスは黙って受け取る（Vonage 側の追加で 4xx を返すと再送が走り続ける）。
  if (status === undefined) return new NextResponse(null, { status: 204 });

  // 冪等キーは webhook の `jti`。at-least-once 配信で取次が余計に 1 手進むのを防ぐ。
  await applyVoiceEventToCorrelation(verified.correlation, { kind: 'status', status }, verified.jti);
  return new NextResponse(null, { status: 204 });
}
