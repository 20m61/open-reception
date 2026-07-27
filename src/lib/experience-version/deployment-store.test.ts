import { beforeEach, describe, expect, it } from 'vitest';
import {
  listDeploymentReports,
  recordDeploymentReport,
  scopeKey,
} from './deployment-store';
import { asSiteId, asTenantId } from '@/domain/tenant/types';

const TENANT = asTenantId('tenant-a');
const SITE = asSiteId('site-1');
const OTHER_SITE = asSiteId('site-2');

const T1 = '2026-07-27T00:00:00.000Z';
const T2 = '2026-07-27T00:00:30.000Z';

beforeEach(async () => {
  // memory backend は module 単位で保持されるため、既存レポートを上書きして影響を消す。
  for (const report of await listDeploymentReports(TENANT, SITE)) {
    await recordDeploymentReport({
      kioskId: report.id,
      tenantId: TENANT,
      siteId: OTHER_SITE,
      reportedAt: T1,
    });
  }
});

describe('recordDeploymentReport', () => {
  it('端末の読み込み版を記録し、拠点で引ける', async () => {
    await recordDeploymentReport({
      kioskId: 'kiosk-1',
      tenantId: TENANT,
      siteId: SITE,
      loadedRevision: 3,
      loadedConfigHash: 'sha256:content',
      reportedAt: T1,
    });

    const reports = await listDeploymentReports(TENANT, SITE);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      id: 'kiosk-1',
      scope: scopeKey(TENANT, SITE),
      loadedRevision: 3,
      loadedConfigHash: 'sha256:content',
      reportedAt: T1,
    });
  });

  it('同一端末の報告は上書きする', async () => {
    await recordDeploymentReport({
      kioskId: 'kiosk-1',
      tenantId: TENANT,
      siteId: SITE,
      loadedRevision: 3,
      loadedConfigHash: 'sha256:old',
      reportedAt: T1,
    });
    await recordDeploymentReport({
      kioskId: 'kiosk-1',
      tenantId: TENANT,
      siteId: SITE,
      loadedRevision: 4,
      loadedConfigHash: 'sha256:new',
      reportedAt: T2,
    });

    const reports = await listDeploymentReports(TENANT, SITE);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ loadedRevision: 4, loadedConfigHash: 'sha256:new' });
  });

  it('読込エラーの報告は、稼働中の版（loaded）を消さない', async () => {
    await recordDeploymentReport({
      kioskId: 'kiosk-1',
      tenantId: TENANT,
      siteId: SITE,
      loadedRevision: 3,
      loadedConfigHash: 'sha256:good',
      reportedAt: T1,
    });

    await recordDeploymentReport({
      kioskId: 'kiosk-1',
      tenantId: TENANT,
      siteId: SITE,
      errorCode: 'asset_load_failed',
      errorRevision: 4,
      reportedAt: T2,
    });

    const reports = await listDeploymentReports(TENANT, SITE);
    expect(reports[0]).toMatchObject({
      loadedRevision: 3,
      loadedConfigHash: 'sha256:good',
      errorCode: 'asset_load_failed',
      errorRevision: 4,
      lastAttemptAt: T2,
    });
  });

  it('成功報告は過去のエラーを引き継がない', async () => {
    await recordDeploymentReport({
      kioskId: 'kiosk-1',
      tenantId: TENANT,
      siteId: SITE,
      errorCode: 'schema_invalid',
      errorRevision: 4,
      reportedAt: T1,
    });

    await recordDeploymentReport({
      kioskId: 'kiosk-1',
      tenantId: TENANT,
      siteId: SITE,
      loadedRevision: 4,
      loadedConfigHash: 'sha256:new',
      reportedAt: T2,
    });

    const reports = await listDeploymentReports(TENANT, SITE);
    expect(reports[0]?.errorCode).toBeUndefined();
    expect(reports[0]?.lastAttemptAt).toBeUndefined();
  });

  it('別拠点の報告は混ざらない', async () => {
    await recordDeploymentReport({
      kioskId: 'kiosk-9',
      tenantId: TENANT,
      siteId: OTHER_SITE,
      loadedRevision: 1,
      reportedAt: T1,
    });

    await expect(listDeploymentReports(TENANT, SITE)).resolves.toEqual([]);
  });
});
