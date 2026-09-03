import { NextResponse } from 'next/server';
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
export async function POST(request: Request): Promise<NextResponse> {
  // 停止スイッチは署名検証より前（止めたい状況では検証の計算もさせない）。
  const disabled = denyIfProviderWebhooksDisabled();
  if (disabled) return disabled;
  const { verified, body } = await verifyRequest(request);
  if (!verified.ok) {
    logWebhookRejection('events', verified.logOnly);
    return rejectWebhook();
  }

  // 既知のステータス一覧は持たない（`VONAGE_CALL_STATUSES` が正本。ここに写しを置くと
  // 片方だけに足したステータスが黙って無視される）。
  // 未知のステータスは黙って受け取る（Vonage 側の追加で 4xx を返すと再送が走り続ける）。
  const { status } = body;
  if (status === undefined) return new NextResponse(null, { status: 204 });

  // 冪等キーは webhook の `jti`。at-least-once 配信で取次が余計に 1 手進むのを防ぐ。
  await applyVoiceEventToCorrelation(verified.correlation, { kind: 'status', status }, verified.jti, {
    // 🔴 `request.url` へ倒れる `resolveWebhookBaseUrl` を使わない。Function URL を渡すと
    // `x-origin-verify` が付かず 2 手目の webhook が全部 403 になり、鳴らしたのに一切
    // 進まない通話が残る（#612 と同型）。**分からないなら撃たない**を成立させるため、
    // 分からないことを `undefined` で表現できる方を使う。
    webhookBaseUrl: resolveDialCallbackBaseUrl(request),
    // この通話を制御する REST の基底 URL。切断（`hang-up.ts`）が近いリージョンへ撃てるよう
    // 相関へ残す。無ければ従来どおりグローバル（`api.nexmo.com`）。
    regionUrl: body.regionUrl,
  });
  return new NextResponse(null, { status: 204 });
}
