import { NextResponse } from 'next/server';
import { buildDetailsNcco, resolveStaffChoice } from '@/domain/call/voice-announcement';
import { rejectWebhook, verifyRequest } from '@/lib/routing/vonage-webhook-route';

/**
 * POST /api/providers/vonage/dtmf — 担当者の DTMF 入力 (issue #4 MVP 1)。
 *
 * 第 1 段で「1」が押された＝**担当者本人が応答した**ので、ここで初めて来訪者情報を
 * 含む第 2 段の NCCO を返す。それ以外の入力では詳細を返さない。
 *
 * 来訪者情報の供給は Inc D（相関 → 受付 → 来訪者）で繋ぐ。現状は本人確認までを配線する。
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
  if (!verified.ok) return rejectWebhook();

  const choice = resolveStaffChoice(readDigits(rawBody) ?? '');
  // 本人確認（1）以外では来訪者情報を返さない。無入力・誤入力もここに落ちる。
  if (choice !== 'accept') return new NextResponse(null, { status: 204 });

  const eventUrl = new URL('/api/providers/vonage/dtmf', request.url).toString();
  return NextResponse.json(
    buildDetailsNcco({
      // Inc D で相関 → 受付から実データを供給する。現時点では PII を出さない定型値。
      visitor: { visitorName: 'ご来訪の方', companyName: 'お客様' },
      eventUrl,
      timeoutSeconds: DTMF_TIMEOUT_SECONDS,
    }),
  );
}
