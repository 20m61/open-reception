import { NextResponse } from 'next/server';
import {
  assertCanReadSite,
  assertCanWriteSite,
  requireActor,
  toGuardResponse,
} from '@/lib/admin/guard';
import { readJson } from '@/lib/data-stores/result-http';
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import { requireActorWithIdentity } from '@/lib/operating-policy/request';
import { asSiteId, asTenantId, type SiteId, type TenantId } from '@/domain/tenant/types';
import type { AuditAction } from '@/domain/reception/log';
import {
  getExperienceVersionService,
  resolveRepresentativeKioskId,
} from '@/lib/experience-version/store';
import type { ServiceError, ServiceResult } from '@/lib/experience-version/service';

/**
 * GET  /api/admin/experience-versions?tenantId=&siteId= — 拠点の受付体験と版履歴 (issue #420)。
 * POST /api/admin/experience-versions                   — 版の操作（下書き保存・承認・公開・切り戻し）。
 *
 * 認可（`.claude/rules/admin-api-authz.md`）: `requireActor` + `assertCanReadSite`/`assertCanWriteSite`。
 * viewer は書込不可（403）。他テナント/サイトの越境も 403。
 * 監査: `experience.draft_saved` / `_approved` / `_published` / `_rolled_back`。metadata は
 * tenantId/siteId/revision/configHash のみで、**構成の中身は残さない**。
 *
 * 版の中身（スナップショット）は応答に含めない。中身が要る画面はプレビュー
 * （`GET /api/configuration/effective?version=draft`）を使う — 同じ resolver を通すため、
 * 「公開したら何が出るか」と一致する。
 */

const ACTIONS = ['save-draft', 'approve', 'publish', 'rollback'] as const;
type Action = (typeof ACTIONS)[number];

const AUDIT_ACTION: Record<Action, AuditAction> = {
  'save-draft': 'experience.draft_saved',
  approve: 'experience.approved',
  publish: 'experience.published',
  rollback: 'experience.rolled_back',
};

const STATUS_BY_REASON: Record<ServiceError, number> = {
  experience_not_found: 404,
  version_not_found: 404,
  revision_conflict: 409,
  not_draft: 409,
  not_approved: 409,
  no_change: 409,
  not_published_before: 409,
  validation_missing: 409,
  validation_failed: 422,
  snapshot_failed: 503,
};

type Scope = { tenantId: TenantId; siteId: SiteId };

function readScope(read: (key: string) => string | undefined): Scope | null {
  const tenantId = read('tenantId');
  const siteId = read('siteId');
  if (!tenantId || !siteId) return null;
  return { tenantId: asTenantId(tenantId), siteId: asSiteId(siteId) };
}

/** 版履歴の応答形（スナップショットは落とす）。 */
function toResponse(experience: Awaited<ReturnType<ReturnType<typeof getExperienceVersionService>['getBySite']>>) {
  if (!experience) return null;
  return {
    id: experience.id,
    name: experience.name,
    updatedAt: experience.updatedAt,
    versions: experience.versions.map(({ snapshot: _snapshot, ...rest }) => rest),
  };
}

export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const scope = readScope((key) => params.get(key) ?? undefined);
  if (!scope) {
    return NextResponse.json({ error: 'invalid_input', message: 'tenantId and siteId are required' }, { status: 400 });
  }
  try {
    assertCanReadSite(await requireActor(), scope.tenantId, scope.siteId);
  } catch (err) {
    return toGuardResponse(err);
  }

  const experience = await getExperienceVersionService().getBySite(scope.tenantId, scope.siteId);
  return NextResponse.json({ experience: toResponse(experience) });
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
  const scope = readScope((key) => (typeof body[key] === 'string' ? (body[key] as string) : undefined));
  if (!scope) {
    return NextResponse.json({ error: 'invalid_input', message: 'tenantId and siteId are required' }, { status: 400 });
  }

  const action = body.action;
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json(
      { error: 'invalid_input', message: `action must be one of ${ACTIONS.join(', ')}` },
      { status: 400 },
    );
  }

  let identity: string;
  try {
    const resolved = await requireActorWithIdentity();
    assertCanWriteSite(resolved.actor, scope.tenantId, scope.siteId);
    identity = resolved.identity;
  } catch (err) {
    return toGuardResponse(err);
  }

  const service = getExperienceVersionService();
  let result: ServiceResult;

  if (action === 'save-draft') {
    // 構成解決に使う代表端末。未指定なら拠点の有効な端末から選ぶ（暫定 ID を持ち込まない）。
    const kioskId =
      (typeof body.kioskId === 'string' && body.kioskId) ||
      (await resolveRepresentativeKioskId(scope.tenantId, scope.siteId));
    if (!kioskId) {
      return NextResponse.json(
        { error: 'no_device_in_site', message: 'the site has no active kiosk to resolve configuration' },
        { status: 409 },
      );
    }
    result = await service.saveDraft({
      ...scope,
      kioskId,
      editorId: identity,
      name: typeof body.name === 'string' ? body.name : undefined,
      baseRevision: typeof body.baseRevision === 'number' ? body.baseRevision : undefined,
    });
  } else {
    const revision = body.revision;
    if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
      return NextResponse.json(
        { error: 'invalid_input', message: 'revision must be a positive integer' },
        { status: 400 },
      );
    }
    result =
      action === 'approve'
        ? await service.approve({ ...scope, revision, approverId: identity })
        : action === 'publish'
          ? await service.publish({ ...scope, revision, publisherId: identity })
          : await service.rollback({ ...scope, revision, actorId: identity });
  }

  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: STATUS_BY_REASON[result.reason] });
  }

  const latest = result.value.versions[result.value.versions.length - 1];
  await appendAdminAudit(
    AUDIT_ACTION[action as Action],
    { type: 'reception_experience', id: result.value.id },
    {
      tenantId: String(scope.tenantId),
      siteId: String(scope.siteId),
      revision: String(latest?.revision ?? ''),
      configHash: String(latest?.configHash ?? ''),
    },
  );

  return NextResponse.json({ experience: toResponse(result.value) });
}
