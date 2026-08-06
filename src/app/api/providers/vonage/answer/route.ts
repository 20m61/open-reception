import { NextResponse } from 'next/server';
import { buildConfirmationNcco } from '@/domain/call/voice-announcement';
import { logWebhookRejection, rejectWebhook, verifyRequest, webhookUrl } from '@/lib/routing/vonage-webhook-route';

/**
 * POST /api/providers/vonage/answer — 担当者が応答したときの NCCO を返す (issue #4 MVP 1)。
 *
 * **第 1 段の NCCO しか返さない。** 誰が出たか分からない時点で来訪者情報を読み上げると、
 * 留守番電話・家族・同僚に伝わる。詳細は DTMF で本人確認した後（/dtmf）に返す。
 *
 * 認可は署名（signed webhook）のみ。管理 actor も kiosk セッションも介在しない公開パス。
 */
const DTMF_TIMEOUT_SECONDS = 20;

export async function POST(request: Request): Promise<NextResponse> {
  const { verified } = await verifyRequest(request);
  if (!verified.ok) {
    logWebhookRejection('answer', verified.logOnly);
    return rejectWebhook();
  }

  const eventUrl = webhookUrl(request, '/api/providers/vonage/dtmf');
  return NextResponse.json(
    buildConfirmationNcco({ eventUrl, timeoutSeconds: DTMF_TIMEOUT_SECONDS }),
  );
}
