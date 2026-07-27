import { NextResponse } from 'next/server';
import { assertCanReadSite, requireActor, toGuardResponse } from '@/lib/admin/guard';
import { asSiteId, asTenantId, type SiteId, type TenantId } from '@/domain/tenant/types';
import {
  classifyDeployment,
  summarizeRollout,
} from '@/domain/experience-version/deployment';
import type { KioskConfigDeployment } from '@/domain/experience-version/types';
import { publishedVersion } from '@/domain/experience-version/lifecycle';
import { listDeploymentReports } from '@/lib/experience-version/deployment-store';
import { getExperienceVersionService } from '@/lib/experience-version/store';
import { getDeviceService } from '@/lib/tenant/store';

/**
 * GET /api/admin/experience-versions/deployments?tenantId=&siteId= (issue #420 Inc3)
 *
 * 「公開したのに、どの端末へ届いていないか」に答える。**端末台帳を母集合**にし、heartbeat の
 * 報告（`lib/experience-version/deployment-store.ts`）と突き合わせて分類する
 * （判定は `domain/experience-version/deployment.ts` の純関数）。報告が無い端末は `pending`。
 *
 * 突き合わせるのは**内容の指紋**（版のスナップショット指紋）。端末ごとに変わる `configHash` は
 * 期待値を 1 つに決められないため使わない。
 *
 * 認可: `requireActor` + `assertCanReadSite`（read 専用ルート）。端末一覧も同じ actor で引き、
 * サイト境界の判定を二重に通す。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const tenantIdRaw = params.get('tenantId');
  const siteIdRaw = params.get('siteId');
  if (!tenantIdRaw || !siteIdRaw) {
    return NextResponse.json(
      { error: 'invalid_input', message: 'tenantId and siteId are required' },
      { status: 400 },
    );
  }
  const tenantId: TenantId = asTenantId(tenantIdRaw);
  const siteId: SiteId = asSiteId(siteIdRaw);

  let actor;
  try {
    actor = await requireActor();
    assertCanReadSite(actor, tenantId, siteId);
  } catch (err) {
    return toGuardResponse(err);
  }

  const experience = await getExperienceVersionService().getBySite(tenantId, siteId);
  const desired = experience ? publishedVersion(experience) : undefined;
  if (!desired) {
    // まだ公開していない拠点。反映状況という概念が無いので空で返す（404 にしない）。
    return NextResponse.json({ desired: null, deployments: [], summary: null });
  }

  const devices = await getDeviceService().list(actor, tenantId, siteId);
  if (!devices.ok) return NextResponse.json({ error: devices.error.code }, { status: 403 });

  const reports = new Map(
    (await listDeploymentReports(tenantId, siteId)).map((r) => [r.id, r]),
  );

  const deployments: KioskConfigDeployment[] = devices.value.map((device) => {
    const report = reports.get(device.id);
    return {
      kioskId: device.id,
      siteId,
      desiredRevision: desired.revision,
      desiredConfigHash: desired.configHash,
      loadedRevision: report?.loadedRevision,
      loadedConfigHash: report?.loadedConfigHash,
      lastAttemptAt: report?.lastAttemptAt,
      errorCode: report?.errorCode,
      errorRevision: report?.errorRevision,
    };
  });

  return NextResponse.json({
    desired: {
      revision: desired.revision,
      contentHash: desired.configHash,
      publishedAt: desired.publishedAt,
    },
    deployments: deployments.map((deployment) => ({
      ...deployment,
      status: classifyDeployment(deployment),
    })),
    summary: summarizeRollout(deployments),
  });
}
