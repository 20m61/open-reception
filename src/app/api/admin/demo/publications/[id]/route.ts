import { NextResponse } from 'next/server';
import {
  assertCanRead,
  assertCanWrite,
  defaultAdminTenantId,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import { listKiosks } from '@/lib/kiosk/kiosk-store';
import {
  isDemoPublishTarget,
  isDemoPublicationStatus,
  publish,
  rollbackTo,
  setStatus,
  type DemoPublishTarget,
} from '@/domain/demo-studio/publication';
import {
  deleteDemoPublication,
  getDemoPublication,
  saveDemoPublication,
  type StoredDemoPublication,
} from '@/domain/demo-studio/publication-store';
import { getSavedDemoScenario } from '@/domain/demo-studio/store';

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET    /api/admin/demo/publications/:id — 公開単位の詳細 (issue #363 Increment 3)。
 * PATCH  /api/admin/demo/publications/:id — 状態遷移。op = set_status | publish | rollback。
 * DELETE /api/admin/demo/publications/:id — 公開単位を削除する。
 *
 * 認可（#91）: GET は read、PATCH/DELETE は write（viewer 不可）。
 *   - publish: 現在の保存済みシナリオをスナップショットし、target を**テナントの実 Kiosk**の
 *     許可一覧で検証する（誤った Site/Kiosk への公開防止, fail-closed）。落選は 422。
 *   - rollback: 過去 version を新 version として復元（append-only）。存在しない version は 422。
 * 監査は event/scenarioId/status/version など**列挙・識別子のみ**（PII/シナリオ文言なし）。
 * action は専用（issue #363 Inc3）: set_status→`reception.demo_status_changed`、
 * publish→`reception.demo_published`、rollback→`reception.demo_rolled_back`、
 * DELETE→`reception.demo_publication_deleted`。
 */

/** テナントの有効な Kiosk から公開許可 target を組む（disabled/未知は除外＝誤公開防止の母集合）。 */
async function resolveAllowedTargets(): Promise<DemoPublishTarget[]> {
  const siteId = String(defaultAdminTenantId());
  const kiosks = await listKiosks();
  return kiosks.filter((k) => k.enabled).map((k) => ({ siteId, kioskId: k.id }));
}

export async function GET(_request: Request, { params }: Ctx): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanRead(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  const { id } = await params;
  const pub = await getDemoPublication(id);
  if (!pub) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json(pub);
}

export async function PATCH(request: Request, { params }: Ctx): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanWrite(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  const { id } = await params;
  const pub = await getDemoPublication(id);
  if (!pub) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid' }, { status: 400 });
  }
  const op = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).op : undefined;
  const now = new Date().toISOString();

  if (op === 'set_status') {
    const status = (body as Record<string, unknown>).status;
    if (!isDemoPublicationStatus(status)) {
      return NextResponse.json({ error: 'invalid' }, { status: 400 });
    }
    const r = setStatus(pub, status, now);
    if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 422 });
    const next: StoredDemoPublication = { ...r.publication, share: pub.share };
    await saveDemoPublication(next);
    await appendAdminAudit(
      'reception.demo_status_changed',
      { type: 'demo_publication', id: pub.id },
      { event: 'status_changed', scenarioId: pub.scenarioId, status },
    );
    return NextResponse.json(next);
  }

  if (op === 'publish') {
    const target = (body as Record<string, unknown>).target;
    if (!isDemoPublishTarget(target)) {
      return NextResponse.json({ error: 'invalid' }, { status: 400 });
    }
    // 公開対象は「現在保存されているシナリオ」のスナップショット（編集後の最新を公開）。
    const scenario = await getSavedDemoScenario(pub.scenarioId);
    if (!scenario) return NextResponse.json({ error: 'unknown_scenario' }, { status: 400 });
    const allowed = await resolveAllowedTargets();
    const r = publish(pub, scenario, target, allowed, now);
    if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 422 });
    const next: StoredDemoPublication = { ...r.publication, share: pub.share };
    await saveDemoPublication(next);
    await appendAdminAudit(
      'reception.demo_published',
      { type: 'demo_publication', id: pub.id },
      {
        event: 'published',
        scenarioId: pub.scenarioId,
        status: next.status,
        version: String(next.currentVersion),
        // target の id は PII ではない運用識別子。誰がどの端末へ公開したかの説明責任のため残す。
        siteId: target.siteId,
        kioskId: target.kioskId,
      },
    );
    return NextResponse.json(next);
  }

  if (op === 'rollback') {
    const version = (body as Record<string, unknown>).version;
    if (typeof version !== 'number' || !Number.isInteger(version)) {
      return NextResponse.json({ error: 'invalid' }, { status: 400 });
    }
    const r = rollbackTo(pub, version, now);
    if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 422 });
    const next: StoredDemoPublication = { ...r.publication, share: pub.share };
    await saveDemoPublication(next);
    await appendAdminAudit(
      'reception.demo_rolled_back',
      { type: 'demo_publication', id: pub.id },
      {
        event: 'rolled_back',
        scenarioId: pub.scenarioId,
        status: next.status,
        version: String(next.currentVersion),
        rolledBackFrom: String(version),
      },
    );
    return NextResponse.json(next);
  }

  return NextResponse.json({ error: 'invalid' }, { status: 400 });
}

export async function DELETE(_request: Request, { params }: Ctx): Promise<NextResponse> {
  try {
    const actor = await requireActor();
    assertCanWrite(actor, defaultAdminTenantId());
  } catch (err) {
    return toGuardResponse(err);
  }
  const { id } = await params;
  const pub = await getDemoPublication(id);
  if (!pub) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  await deleteDemoPublication(id);
  await appendAdminAudit(
    'reception.demo_publication_deleted',
    { type: 'demo_publication', id: pub.id },
    { event: 'publication_deleted', scenarioId: pub.scenarioId },
  );
  return NextResponse.json({ ok: true });
}
