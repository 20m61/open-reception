import { NextResponse } from 'next/server';
import { getReception, markConnected } from '@/lib/data-stores/reception-store';
import { resolveVonageSessionService } from '@/lib/call/adapter-factory';
import { getVonagePublicConfigForTenant } from '@/lib/call/vonage-config';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';
import { readAnswerToken } from '@/lib/call/answer-token';
import { readJson } from '@/lib/data-stores/result-http';

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

  // テナント/サイト境界は営業時間ガード/routing と同じ既定スコープ規則で解決する（単一テナント既定）。
  const { tenantId } = resolveDefaultScope();
  const service = await resolveVonageSessionService(tenantId);
  const publicConfig = await getVonagePublicConfigForTenant(tenantId);
  const sessionId = found.value.vonageSessionId;
  if (!service || !publicConfig || !sessionId) {
    return NextResponse.json(
      { error: 'unavailable', message: 'vonage call session is not available' },
      { status: 409 },
    );
  }

  // 先に subscriber トークンを発行する。発行失敗時は受付状態を変えない（不整合防止）。
  let token;
  try {
    token = await service.issueToken({ sessionId }, 'subscriber');
  } catch {
    return NextResponse.json({ error: 'vonage_error', message: 'failed to issue token' }, { status: 502 });
  }

  // calling → connected を確定（担当者応答として監査）。
  // 既に connected（再参加 / 二重 POST）の場合は冪等にトークンを返す。
  const connected = await markConnected(id, 'staff');
  if (!connected.ok && found.value.state !== 'connected') {
    return NextResponse.json(
      { error: connected.error.code, message: connected.error.message },
      { status: 409 },
    );
  }

  return NextResponse.json({
    applicationId: publicConfig.applicationId,
    sessionId,
    token: token.token,
    role: token.role,
    expiresAt: token.expiresAt,
  });
}
