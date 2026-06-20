import { NextResponse } from 'next/server';
import { recordStaffResponse } from '@/lib/mock-backend/reception-store';
import { readAnswerToken } from '@/lib/call/answer-token';
import { readJson } from '@/lib/mock-backend/result-http';
import { isStaffResponseAction } from '@/domain/reception/staff-response';

/**
 * POST /api/staff/calls/:id/respond — 担当者が応答アクションを選ぶ (issue #99 increment 1)。
 *
 * 既存の /answer（通話に参加して connected 確定）とは別の導線。応答種別を受け取り、
 * 来訪者向けメッセージを受付端末へ反映できるよう session.staffResponse に記録する。
 *
 * 認可は /answer と同じ署名付き応答トークン（body.token）。トークンの receptionId が
 * パスと一致する場合のみ受け付ける。来訪者向け文言・PII は返さない（応答種別のみ）。
 *
 * 状態が calling/connected でない場合は 409、リンク無効/別受付は 403、不正な種別は 400。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const body = (await readJson(request)) as { token?: string; action?: unknown } | null;

  const answer = await readAnswerToken(body?.token);
  if (!answer || answer.receptionId !== id) {
    return NextResponse.json({ error: 'forbidden', message: 'invalid answer token' }, { status: 403 });
  }

  if (!isStaffResponseAction(body?.action)) {
    return NextResponse.json({ error: 'invalid_input', message: 'unknown response action' }, { status: 400 });
  }

  const result = await recordStaffResponse(id, body.action);
  if (!result.ok) {
    const status = result.error.code === 'not_found' ? 404 : result.error.code === 'invalid_transition' ? 409 : 400;
    return NextResponse.json({ error: result.error.code, message: result.error.message }, { status });
  }

  return NextResponse.json(result.value);
}
