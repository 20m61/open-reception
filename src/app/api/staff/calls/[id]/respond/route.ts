import { NextResponse } from 'next/server';
import { getReception, recordStaffResponse } from '@/lib/mock-backend/reception-store';
import { readAnswerToken } from '@/lib/call/answer-token';
import { readJson } from '@/lib/mock-backend/result-http';
import {
  isStaffResponseAction,
  isStaffResponseEnabled,
  resolveStaffResponseDefinitions,
  resolvedVisitorMessageFor,
} from '@/domain/reception/staff-response';
import { resolveCheckinScope } from '@/lib/checkin/store';
import { getStaffResponseConfigService } from '@/lib/reception/staff-response-config/store';

/**
 * 受付の scope から応答設定（overrides）を解決する内部ヘルパ。
 * 受付が存在しなければ null（呼び出し側で 404 / 既定フォールバックを判断）。
 */
async function resolveOverridesForReception(id: string) {
  const reception = await getReception(id);
  if (!reception.ok) return null;
  const scope = resolveCheckinScope(reception.value.kioskId);
  return getStaffResponseConfigService().resolveOverrides(scope.tenantId, scope.siteId);
}

/**
 * GET /api/staff/calls/:id/respond?token= — この受付で担当者が選べる応答種別を返す
 * (issue #99 increment 2)。担当者 UI が無効化された種別を表示しないために使う。
 *
 * 認可は POST と同じ署名付き応答トークン。返すのは応答種別のメタ（種別・担当者ラベル・
 * トーン・確認要否・有効/無効）のみで、来訪者文言や PII は返さない。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const token = new URL(request.url).searchParams.get('token') ?? undefined;

  const answer = await readAnswerToken(token);
  if (!answer || answer.receptionId !== id) {
    return NextResponse.json({ error: 'forbidden', message: 'invalid answer token' }, { status: 403 });
  }

  const overrides = (await resolveOverridesForReception(id)) ?? {};
  const actions = resolveStaffResponseDefinitions(overrides).map((d) => ({
    action: d.action,
    staffLabel: d.staffLabel,
    severity: d.severity,
    requiresConfirmation: d.requiresConfirmation,
    enabled: d.enabled,
  }));
  return NextResponse.json({ actions });
}

/**
 * POST /api/staff/calls/:id/respond — 担当者が応答アクションを選ぶ (issue #99 increment 1/2)。
 *
 * 既存の /answer（通話に参加して connected 確定）とは別の導線。応答種別を受け取り、
 * 来訪者向けメッセージを受付端末へ反映できるよう session.staffResponse に記録する。
 *
 * 認可は /answer と同じ署名付き応答トークン（body.token）。トークンの receptionId が
 * パスと一致する場合のみ受け付ける。来訪者向け文言・PII は返さない（応答種別のみ）。
 *
 * inc2: 受付の scope（tenant/site）の応答設定を尊重する。無効化された種別は 409 で拒否し、
 * 文言上書きを来訪者表示へ反映する。設定が無ければ既定にフォールバック（inc1 挙動を維持）。
 *
 * 状態が calling/connected でない場合は 409、リンク無効/別受付は 403、不正な種別は 400、
 * 無効化された種別は 409。
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
  const action = body.action;

  // 受付の scope から応答設定を解決する（未設定なら全種別既定で空に等しい）。
  const overrides = await resolveOverridesForReception(id);
  if (overrides === null) {
    return NextResponse.json({ error: 'not_found', message: 'reception not found' }, { status: 404 });
  }

  if (!isStaffResponseEnabled(action, overrides)) {
    return NextResponse.json(
      { error: 'action_disabled', message: 'this response action is disabled for this site' },
      { status: 409 },
    );
  }

  const messageOverride = resolvedVisitorMessageFor(action, overrides);
  const result = await recordStaffResponse(id, action, { messageOverride });
  if (!result.ok) {
    const status = result.error.code === 'not_found' ? 404 : result.error.code === 'invalid_transition' ? 409 : 400;
    return NextResponse.json({ error: result.error.code, message: result.error.message }, { status });
  }

  return NextResponse.json(result.value);
}
