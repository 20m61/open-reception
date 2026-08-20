import { NextResponse } from 'next/server';
import type { VonageCallStatus } from '@/domain/call/voice-call-state';
import {
  logWebhookRejection,
  rejectWebhook,
  verifyRequest,
} from '@/lib/routing/vonage-webhook-route';
import { resolveDialCallbackBaseUrl } from '@/lib/routing/webhook-base-url';
import { denyIfProviderWebhooksDisabled } from '@/lib/routing/provider-webhook-switch';
import { applyVoiceEventToCorrelation } from '@/lib/routing/voice-event';

/**
 * POST /api/providers/vonage/events — 通話ステータスの webhook (issue #4 MVP 1)。
 *
 * 受け取ったステータスを状態機械へ通し、相関へ保存する（Inc D-2 で配線）。
 * 次の手の**発信**もここから起きる (#646) ── 条件が揃わなければ撃たず、位置も動かさない
 * （判断は `applyVoiceEventToCorrelation`）。
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
  // 停止スイッチは署名検証より前（止めたい状況では検証の計算もさせない）。
  const disabled = denyIfProviderWebhooksDisabled();
  if (disabled) return disabled;
  const { verified, rawBody } = await verifyRequest(request);
  if (!verified.ok) {
    logWebhookRejection('events', verified.logOnly);
    return rejectWebhook();
  }

  const status = readStatus(rawBody);
  // 未知のステータスは黙って受け取る（Vonage 側の追加で 4xx を返すと再送が走り続ける）。
  if (status === undefined) return new NextResponse(null, { status: 204 });

  // 冪等キーは webhook の `jti`。at-least-once 配信で取次が余計に 1 手進むのを防ぐ。
  await applyVoiceEventToCorrelation(verified.correlation, { kind: 'status', status }, verified.jti, {
    // 🔴 `request.url` へ倒れる `resolveWebhookBaseUrl` を使わない。Function URL を渡すと
    // `x-origin-verify` が付かず 2 手目の webhook が全部 403 になり、鳴らしたのに一切
    // 進まない通話が残る（#612 と同型）。**分からないなら撃たない**を成立させるため、
    // 分からないことを `undefined` で表現できる方を使う。
    webhookBaseUrl: resolveDialCallbackBaseUrl(request),
  });
  return new NextResponse(null, { status: 204 });
}
