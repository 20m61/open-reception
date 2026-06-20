import { NextResponse } from 'next/server';
import { getReception, markConnected } from '@/lib/mock-backend/reception-store';
import { getVonageSessionService } from '@/lib/call/adapter-factory';
import { getVonagePublicConfig } from '@/lib/call/vonage-config';
import { readAnswerToken } from '@/lib/call/answer-token';
import { readJson } from '@/lib/mock-backend/result-http';

/**
 * POST /api/staff/calls/:id/answer — 担当者が通話に応答する (issue #4 increment 2c)。
 *
 * 認可は通知リンクの署名付き応答トークン（body.token）。トークンの receptionId が
 * パスと一致する場合のみ subscriber トークンを発行し、受付を connected に確定する。
 * secret は返さない（applicationId / sessionId / 短命 token のみ）。
 *
 * 状態が calling でない（未確立 / 既応答 / 取消）場合は 409。リンク無効/別受付は 403。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const body = (await readJson(request)) as { token?: string } | null;

  const answer = await readAnswerToken(body?.token);
  if (!answer || answer.receptionId !== id) {
    return NextResponse.json({ error: 'forbidden', message: 'invalid answer token' }, { status: 403 });
  }

  const found = await getReception(id);
  if (!found.ok) {
    return NextResponse.json({ error: 'not_found', message: 'reception not found' }, { status: 404 });
  }

  const service = getVonageSessionService();
  const publicConfig = getVonagePublicConfig();
  const sessionId = found.value.vonageSessionId;
  if (!service || !publicConfig || !sessionId) {
    return NextResponse.json(
      { error: 'unavailable', message: 'vonage call session is not available' },
      { status: 409 },
    );
  }

  // calling → connected を確定（未応答状態以外は不正遷移として 409）。
  const connected = await markConnected(id);
  if (!connected.ok) {
    return NextResponse.json(
      { error: connected.error.code, message: connected.error.message },
      { status: 409 },
    );
  }

  const token = await service.issueToken({ sessionId }, 'subscriber');
  return NextResponse.json({
    applicationId: publicConfig.applicationId,
    sessionId,
    token: token.token,
    role: token.role,
    expiresAt: token.expiresAt,
  });
}
