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
import {
  deleteSavedDemoScenario,
  getSavedDemoScenario,
  resolveDemoScenario,
  saveDemoScenario,
} from '@/domain/demo-studio/store';

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET    /api/admin/demo/scenarios/:id — シナリオ解決（**保存済み→組込**）(issue #363 Inc2)。
 *   プレビュー iframe が id ひとつでカスタム・組込を解決する単一の解決点。
 * PUT    /api/admin/demo/scenarios/:id — 既存カスタムシナリオを更新（body の id は無視しパス id で保存）。
 * DELETE /api/admin/demo/scenarios/:id — カスタムシナリオを削除（組込テンプレートは削除不可 404）。
 *
 * 認可（#91）: GET は read、PUT/DELETE は write（viewer 不可）。更新は validateDemoScenario を強制し、
 * 監査 reception.demo_scenario_saved / _deleted を scenarioId・initialMode（列挙）のみで残す（PII なし）。
 */
export async function GET(_request: Request, { params }: Ctx): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanRead(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  const { id } = await params;
  const scenario = await resolveDemoScenario(id);
  if (!scenario) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json(scenario);
}

export async function PUT(request: Request, { params }: Ctx): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanWrite(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  const { id } = await params;

  // 更新対象は保存済みカスタムシナリオのみ（組込テンプレートは読み取り専用）。
  const existing = await getSavedDemoScenario(id);
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid' }, { status: 400 });
  }

  // body の id は信用せず、パスの id で確定する。
  const candidate =
    typeof body === 'object' && body !== null ? { ...(body as Record<string, unknown>), id } : body;
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
  return NextResponse.json(result.scenario);
}

export async function DELETE(_request: Request, { params }: Ctx): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanWrite(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  const { id } = await params;

  // 保存済みカスタムのみ削除可（組込テンプレート id は 404）。
  const existing = await getSavedDemoScenario(id);
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  await deleteSavedDemoScenario(id);
  await appendAdminAudit(
    'reception.demo_scenario_deleted',
    { type: 'demo_scenario', id: existing.id },
    { scenarioId: existing.id, initialMode: existing.initialMode },
  );
  return NextResponse.json({ ok: true });
}
