/**
 * GET /api/admin/experience-versions/deployments のテスト (#420 Inc3)。
 * AC「公開後、各端末の反映済み/未反映/失敗を確認できる」を固定する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireActor = vi.fn();
const getBySite = vi.fn();
const listDeploymentReports = vi.fn();
const listDevices = vi.fn();

vi.mock('@/lib/admin/guard', async () => {
  const actual = await vi.importActual<typeof import('@/lib/admin/guard')>('@/lib/admin/guard');
  return { ...actual, requireActor: () => requireActor() };
});
vi.mock('@/lib/experience-version/store', () => ({
  getExperienceVersionService: () => ({ getBySite: (...a: unknown[]) => getBySite(...a) }),
}));
vi.mock('@/lib/experience-version/deployment-store', () => ({
  listDeploymentReports: (...a: unknown[]) => listDeploymentReports(...a),
}));
vi.mock('@/lib/tenant/store', () => ({
  getDeviceService: () => ({ list: (...a: unknown[]) => listDevices(...a) }),
}));

import { GET } from './route';
import { asSiteId, asTenantId, type RoleAssignment } from '@/domain/tenant/types';

const ADMIN_A = {
  status: 'active' as const,
  assignments: [
    { role: 'tenant_admin', tenantId: asTenantId('tenant-a'), siteId: null, deviceId: null },
  ] satisfies RoleAssignment[],
};

const PUBLISHED = {
  revision: 3,
  status: 'published' as const,
  configHash: 'sha256:content-v3',
  createdBy: 'admin-1',
  createdAt: '2026-07-27T00:00:00.000Z',
  publishedAt: '2026-07-27T01:00:00.000Z',
};

const EXPERIENCE = {
  id: 'tenant-a:site-1',
  tenantId: asTenantId('tenant-a'),
  siteId: asSiteId('site-1'),
  name: '本社受付',
  updatedAt: '2026-07-27T01:00:00.000Z',
  versions: [PUBLISHED],
};

function call(query = '?tenantId=tenant-a&siteId=site-1'): Promise<Response> {
  return GET(new Request(`https://example.com/api/admin/experience-versions/deployments${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  requireActor.mockResolvedValue(ADMIN_A);
  getBySite.mockResolvedValue(EXPERIENCE);
  listDeploymentReports.mockResolvedValue([]);
  listDevices.mockResolvedValue({ ok: true, value: [{ id: 'kiosk-1' }] });
});

describe('反映状況の集計', () => {
  it('端末台帳を母集合にし、報告が無い端末は pending にする', async () => {
    listDevices.mockResolvedValue({ ok: true, value: [{ id: 'kiosk-1' }, { id: 'kiosk-2' }] });

    const body = await (await call()).json();

    expect(body.desired).toEqual({
      revision: 3,
      contentHash: 'sha256:content-v3',
      publishedAt: '2026-07-27T01:00:00.000Z',
    });
    expect(body.deployments.map((d: { kioskId: string; status: string }) => [d.kioskId, d.status])).toEqual([
      ['kiosk-1', 'pending'],
      ['kiosk-2', 'pending'],
    ]);
    expect(body.summary).toMatchObject({ total: 2, pending: 2, complete: false });
  });

  it('反映済み・古い版・失敗を区別する', async () => {
    listDevices.mockResolvedValue({
      ok: true,
      value: [{ id: 'kiosk-1' }, { id: 'kiosk-2' }, { id: 'kiosk-3' }],
    });
    listDeploymentReports.mockResolvedValue([
      { id: 'kiosk-1', loadedRevision: 3, loadedConfigHash: 'sha256:content-v3' },
      { id: 'kiosk-2', loadedRevision: 2, loadedConfigHash: 'sha256:content-v2' },
      {
        id: 'kiosk-3',
        loadedRevision: 2,
        loadedConfigHash: 'sha256:content-v2',
        errorCode: 'asset_load_failed',
        errorRevision: 3,
        lastAttemptAt: '2026-07-27T02:00:00.000Z',
      },
    ]);

    const body = await (await call()).json();

    expect(body.deployments.map((d: { status: string }) => d.status)).toEqual([
      'applied',
      'stale',
      'failed',
    ]);
    expect(body.summary).toEqual({
      total: 3,
      applied: 1,
      pending: 0,
      stale: 1,
      failed: 1,
      complete: false,
    });
  });

  it('全端末が反映済みなら complete', async () => {
    listDeploymentReports.mockResolvedValue([
      { id: 'kiosk-1', loadedRevision: 3, loadedConfigHash: 'sha256:content-v3' },
    ]);

    const body = await (await call()).json();

    expect(body.summary).toMatchObject({ total: 1, applied: 1, complete: true });
  });

  it('台帳に無い端末の報告は集計に含めない（母集合は端末台帳）', async () => {
    listDeploymentReports.mockResolvedValue([
      { id: 'kiosk-1', loadedRevision: 3, loadedConfigHash: 'sha256:content-v3' },
      { id: 'kiosk-ghost', loadedRevision: 3, loadedConfigHash: 'sha256:content-v3' },
    ]);

    const body = await (await call()).json();

    expect(body.summary.total).toBe(1);
  });

  it('未公開の拠点は空で返す（404 にしない）', async () => {
    getBySite.mockResolvedValue(undefined);

    const res = await call();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ desired: null, deployments: [], summary: null });
  });
});

describe('認可', () => {
  it('別テナントの拠点は 403', async () => {
    const res = await call('?tenantId=tenant-b&siteId=site-1');
    expect(res.status).toBe(403);
  });

  it('端末一覧の認可が落ちれば 403', async () => {
    listDevices.mockResolvedValue({ ok: false, error: { code: 'forbidden' } });

    const res = await call();

    expect(res.status).toBe(403);
  });

  it('スコープ未指定は 400', async () => {
    const res = await call('?tenantId=tenant-a');
    expect(res.status).toBe(400);
  });
});
