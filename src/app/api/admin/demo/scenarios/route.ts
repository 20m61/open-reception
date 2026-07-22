import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  assertCanRead,
  assertCanWrite,
  defaultAdminTenantId,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import { validateDemoScenario } from '@/domain/demo-studio/scenario';
import { listSavedDemoScenarios, saveDemoScenario } from '@/domain/demo-studio/store';

/**
 * GET  /api/admin/demo/scenarios — 保存済みカスタムデモシナリオ一覧 (issue #363 Inc2)。
 * POST /api/admin/demo/scenarios — 組込テンプレートから複製したカスタムシナリオを新規保存する。
 *
 * 認可（#91 / rules/admin-api-authz.md）: requireActor + assertCanRead/assertCanWrite。
 * 受付体験スタジオはテナント管理者向けの体験設定ツールなので、保存は書込権を要求し viewer は 403。
 * 保存は validateDemoScenario を**強制**し、型不正・未知 mode・巨大入力・URL/スクリプト混入は
 * フィールド別エラー付き 400 で拒否する（sandbox 内容境界）。監査 metadata は scenarioId・
 * initialMode（列挙のみ）で、シナリオ文言（PII ではない擬似ラベル）も残さない。
 */
export async function GET(): Promise<NextResponse> {
  let actor;
  try {
    actor = await requireActor();
    assertCanRead(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  return NextResponse.json(await listSavedDemoScenarios());
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanWrite(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid' }, { status: 400 });
  }

  // id は必ずサーバが合成する（クライアント指定 id を信用せず、collection キー注入を防ぐ）。
  const candidate =
    typeof body === 'object' && body !== null
      ? { ...(body as Record<string, unknown>), id: `custom-${randomUUID()}` }
      : body;

  const result = validateDemoScenario(candidate);
  if (!result.ok) {
    return NextResponse.json({ error: 'invalid_scenario', errors: result.errors }, { status: 400 });
  }

  await saveDemoScenario(result.scenario);
  await appendAdminAudit(
    'reception.demo_scenario_saved',
    { type: 'demo_scenario', id: result.scenario.id },
    { scenarioId: result.scenario.id, initialMode: result.scenario.initialMode },
  );
  return NextResponse.json(result.scenario, { status: 201 });
}
