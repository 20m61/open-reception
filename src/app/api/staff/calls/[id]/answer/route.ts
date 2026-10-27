import { NextResponse } from 'next/server';
import { getReception, markConnected } from '@/lib/data-stores/reception-store';
import { resolveVonageSessionAccess } from '@/lib/call/vonage-session-access';
import { getAnswerSecret, readAnswerToken } from '@/lib/call/answer-token';
import { secretUnavailableResponse } from '@/lib/auth/secret-unavailable';
import { readJson } from '@/lib/data-stores/result-http';

/**
 * POST /api/staff/calls/:id/answer — 担当者が通話に応答する (issue #4 increment 2c)。
 *
 * 認可は通知リンクの署名付き応答トークン（body.token）。トークンの receptionId が
 * パスと一致する場合のみ subscriber トークンを発行し、受付を connected に確定する。
 * secret は返さない（applicationId / sessionId / 短命 token のみ）。
 *
 * 状態が calling でない（未確立 / 既応答 / 取消）場合は 409。リンク無効/別受付は 403。
 *
 * トークンはセッションを作ったテナントの Vonage 設定で発行する（`lib/call/vonage-session-access.ts`）。
 * 応答トークンが主張する担当者のテナントがそれと違えば 404（存在しない受付と同じ応答）で、
 * 受付の状態も変えない。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const body = (await readJson(request)) as { token?: string } | null;

  // 🔴 鍵未設定デプロイで uncaught にしない。**catch の射程は鍵の解決だけ**
  // （理由と、広げたときに何が壊れるかは `src/lib/auth/secret-unavailable.ts` に 1 度だけ書く）。
  // 射程は route テストの「鍵以外の throw は 503 に化けない」が縛る (#1123)。
  try {
    getAnswerSecret();
  } catch {
    return secretUnavailableResponse('CALL_ANSWER_SECRET');
  }
  const answer = await readAnswerToken(body?.token);
  if (!answer || answer.receptionId !== id) {
    return NextResponse.json({ error: 'forbidden', message: 'invalid answer token' }, { status: 403 });
  }

  const found = await getReception(id);
  if (!found.ok) return receptionNotFound();
  // 担当者のテナント（応答トークンの署名済みの主張）が、セッションの所有テナント（作成時に
  // 記録）と違えば、存在しない受付と同じ 404 を返す。Vonage の設定は所有テナントから引く。
  const access = await resolveVonageSessionAccess(found.value, answer.tenantId);
  if (access.kind === 'mismatch') return receptionNotFound();
  if (access.kind === 'unavailable') {
    return NextResponse.json(
      { error: 'unavailable', message: 'vonage call session is not available' },
      { status: 409 },
    );
  }
  const { service, sessionId } = access;

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
    applicationId: access.applicationId,
    sessionId,
    token: token.token,
    role: token.role,
    expiresAt: token.expiresAt,
  });
}

function receptionNotFound(): NextResponse {
  return NextResponse.json({ error: 'not_found', message: 'reception not found' }, { status: 404 });
}
