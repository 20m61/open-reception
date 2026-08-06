import { NextResponse } from 'next/server';
import { buildDetailsNcco, resolveStaffChoice } from '@/domain/call/voice-announcement';
import { logWebhookRejection, rejectWebhook, verifyRequest, webhookUrl } from '@/lib/routing/vonage-webhook-route';

/**
 * POST /api/providers/vonage/dtmf — **第 1 段**（本人確認）の DTMF (issue #4 MVP 1)。
 *
 * 「1」が押された＝担当者本人が応答した、とみなして初めて来訪者情報を返す。
 *
 * **段階はエンドポイントで持つ。** 第 2 段（選択）の `eventUrl` は `/choice` を指し、
 * ここへは戻らない。同じ URL を使い回すと第 2 段の「1」がここへ届き、来訪者情報を
 * 無限に読み上げ続ける（実際にそうなっていた）。クエリで段階を渡す案は採らない ──
 * POST では `payload_hash` の対象外で、付け替えられる。
 */
const DTMF_TIMEOUT_SECONDS = 20;

function readDigits(rawBody: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const dtmf = (parsed as Record<string, unknown>).dtmf;
    if (dtmf === null || typeof dtmf !== 'object') return undefined;
    const digits = (dtmf as Record<string, unknown>).digits;
    return typeof digits === 'string' ? digits : undefined;
  } catch {
    return undefined;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const { verified, rawBody } = await verifyRequest(request);
  if (!verified.ok) {
    logWebhookRejection('dtmf', verified.logOnly);
    return rejectWebhook();
  }

  const choice = resolveStaffChoice(readDigits(rawBody) ?? '');
  // 本人確認（1）以外では来訪者情報を返さない。無入力・誤入力もここに落ちる。
  if (choice !== 'accept') return new NextResponse(null, { status: 204 });

  return NextResponse.json(
    buildDetailsNcco({
      // Inc D で相関 → 受付から実データを供給する。現時点では PII を出さない定型値。
      visitor: { visitorName: 'ご来訪の方', companyName: 'お客様' },
      eventUrl: webhookUrl(request, '/api/providers/vonage/choice'),
      timeoutSeconds: DTMF_TIMEOUT_SECONDS,
    }),
  );
}
