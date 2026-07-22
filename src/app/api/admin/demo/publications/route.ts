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
import { createPublication } from '@/domain/demo-studio/publication';
import { listDemoPublications, saveDemoPublication } from '@/domain/demo-studio/publication-store';
import { getSavedDemoScenario } from '@/domain/demo-studio/store';

/**
 * GET  /api/admin/demo/publications — デモ公開単位の一覧 (issue #363 Increment 3)。
 * POST /api/admin/demo/publications — 保存済みカスタムシナリオから公開単位（draft）を新規作成する。
 *
 * 認可（#91 / rules/admin-api-authz.md）: requireActor + assertCanRead/assertCanWrite。
 * 作成は書込権を要求し viewer は 403。id はサーバ合成（クライアント指定 id を信用しない）。
 * 対象シナリオが保存済みに無ければ 400。監査は scenarioId のみ（PII/シナリオ文言は残さない）。
 *
 * 監査 action: `reception.demo_publication_created`（専用 action, issue #363 Inc3）。
 */
export async function GET(): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanRead(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  return NextResponse.json(await listDemoPublications());
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

  const scenarioId =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>).scenarioId
      : undefined;
  if (typeof scenarioId !== 'string') {
    return NextResponse.json({ error: 'invalid' }, { status: 400 });
  }

  // 公開対象は保存済みカスタムシナリオのみ（組込テンプレート/未知 id は不可）。
  const scenario = await getSavedDemoScenario(scenarioId);
  if (!scenario) {
    return NextResponse.json({ error: 'unknown_scenario' }, { status: 400 });
  }

  const publication = createPublication(`pub-${randomUUID()}`, scenario.id, new Date().toISOString());
  await saveDemoPublication(publication);
  await appendAdminAudit(
    'reception.demo_publication_created',
    { type: 'demo_publication', id: publication.id },
    { event: 'publication_created', scenarioId: scenario.id, status: publication.status },
  );
  return NextResponse.json(publication, { status: 201 });
}
