import { NextResponse } from 'next/server';
import { DTMF_CHOICES, resolveStaffChoice, staffChoiceToRouteResult } from '@/domain/call/voice-announcement';
import { logWebhookRejection, rejectWebhook, verifyRequest } from '@/lib/routing/vonage-webhook-route';

/**
 * POST /api/providers/vonage/choice — **第 2 段**（意思表示）の DTMF (issue #4 MVP 1)。
 *
 * 来訪者情報を案内した後の選択（来訪者と話す / まもなく向かう / 対応できない / 代理へ）。
 * ここは `/dtmf` と分けてある ── 同じ URL だと第 2 段の「1」が第 1 段として解釈され、
 * 来訪者情報を無限に読み上げる。
 *
 * **どの選択でも必ず音声で応答する。** 無応答で切ると、担当者は自分の入力が
 * 届いたのか分からないまま切ることになる。取次への反映は Inc D。
 */
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

/** 選択を受け取ったことを担当者へ返す（PII を含めない定型文）。 */
function acknowledgement(text: string): NextResponse {
  return NextResponse.json([
    { action: 'talk', text, language: 'ja-JP', bargeIn: false },
  ]);
}

export async function POST(request: Request): Promise<NextResponse> {
  const { verified, rawBody } = await verifyRequest(request);
  if (!verified.ok) {
    logWebhookRejection('choice', verified.logOnly);
    return rejectWebhook();
  }

  const choice = resolveStaffChoice(readDigits(rawBody) ?? '');
  if (choice === undefined) {
    // 誤入力・無入力。選択肢を読み直す（黙って切らない）。
    const options = DTMF_CHOICES.map((c) => `${c.digit}、${c.label}。`).join('');
    return acknowledgement(`入力を確認できませんでした。${options}`);
  }

  // 取次語彙への写像は Inc D で Orchestrator へ渡す。ここでは受領応答のみ。
  void staffChoiceToRouteResult(choice);
  const label = DTMF_CHOICES.find((c) => c.choice === choice)?.label ?? '';
  return acknowledgement(`${label}、で承りました。`);
}
