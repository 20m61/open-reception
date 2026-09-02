/**
 * /api/admin/experience-versions のテスト (#420 Inc2)。
 * 認可（越境・viewer 書込）と、応答にスナップショット（構成の中身）を出さないことを固定する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireActor = vi.fn();
const requireActorWithIdentity = vi.fn();
const appendAdminAudit = vi.fn();
const resolveRepresentativeKioskId = vi.fn();
const service = {
  getBySite: vi.fn(),
  saveDraft: vi.fn(),
  approve: vi.fn(),
  publish: vi.fn(),
  rollback: vi.fn(),
};

vi.mock('@/lib/admin/guard', async () => {
  const actual = await vi.importActual<typeof import('@/lib/admin/guard')>('@/lib/admin/guard');
  return { ...actual, requireActor: () => requireActor() };
});
vi.mock('@/lib/operating-policy/request', () => ({
  requireActorWithIdentity: () => requireActorWithIdentity(),
}));
vi.mock('@/lib/data-stores/reception-log-store', () => ({
  appendAdminAudit: (...a: unknown[]) => appendAdminAudit(...a),
}));
vi.mock('@/lib/experience-version/store', () => ({
  getExperienceVersionService: () => service,
  resolveRepresentativeKioskId: (...a: unknown[]) => resolveRepresentativeKioskId(...a),
}));

import { GET, POST } from './route';
import { asSiteId, asTenantId, type RoleAssignment } from '@/domain/tenant/types';

const TENANT_A = asTenantId('tenant-a');
const SITE_1 = asSiteId('site-1');

function assign(role: RoleAssignment['role'], tenantId: string): RoleAssignment {
  return { role, tenantId: asTenantId(tenantId), siteId: null, deviceId: null };
}

const ADMIN_A = { status: 'active' as const, assignments: [assign('tenant_admin', 'tenant-a')] };
const VIEWER_A = { status: 'active' as const, assignments: [assign('viewer', 'tenant-a')] };

const EXPERIENCE = {
  id: 'tenant-a:site-1',
  tenantId: TENANT_A,
  siteId: SITE_1,
  name: '本社受付',
  updatedAt: '2026-07-27T00:00:00.000Z',
  versions: [
    {
      revision: 1,
      status: 'published' as const,
      configHash: 'sha256:aaa',
      snapshot: { sections: { branding: { accentColor: '#secret-ish' } }, configHash: 'sha256:aaa' },
      createdBy: 'admin-1',
      createdAt: '2026-07-27T00:00:00.000Z',
    },
  ],
};

function post(body: Record<string, unknown>): Request {
  return new Request('https://example.com/api/admin/experience-versions', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireActor.mockResolvedValue(ADMIN_A);
  requireActorWithIdentity.mockResolvedValue({ actor: ADMIN_A, identity: 'admin-1' });
  service.getBySite.mockResolvedValue(EXPERIENCE);
  service.publish.mockResolvedValue({ ok: true, value: EXPERIENCE });
  service.saveDraft.mockResolvedValue({ ok: true, value: EXPERIENCE });
  service.rollback.mockResolvedValue({ ok: true, value: EXPERIENCE });
  service.approve.mockResolvedValue({ ok: true, value: EXPERIENCE });
  resolveRepresentativeKioskId.mockResolvedValue('kiosk-1');
});

describe('GET', () => {
  it('版履歴を返すが、構成の中身（スナップショット）は含めない', async () => {
    const res = await GET(
      new Request('https://example.com/api/admin/experience-versions?tenantId=tenant-a&siteId=site-1'),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.experience.versions[0]).toMatchObject({ revision: 1, configHash: 'sha256:aaa' });
    expect(body.experience.versions[0].snapshot).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('#secret-ish');
  });

  it('スコープ未指定は 400', async () => {
    const res = await GET(new Request('https://example.com/api/admin/experience-versions'));
    expect(res.status).toBe(400);
  });

  it('別テナントの拠点は 403', async () => {
    const res = await GET(
      new Request('https://example.com/api/admin/experience-versions?tenantId=tenant-b&siteId=site-1'),
    );
    expect(res.status).toBe(403);
  });

  it('体験が無ければ null を返す（404 にしない）', async () => {
    service.getBySite.mockResolvedValue(undefined);

    const res = await GET(
      new Request('https://example.com/api/admin/experience-versions?tenantId=tenant-a&siteId=site-1'),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ experience: null });
  });
});

describe('POST', () => {
  it('公開を実行し、監査へ版番号と指紋だけを残す（構成の中身は残さない）', async () => {
    const res = await POST(
      post({ tenantId: 'tenant-a', siteId: 'site-1', action: 'publish', revision: 1 }),
    );

    expect(res.status).toBe(200);
    expect(service.publish).toHaveBeenCalledWith({
      tenantId: TENANT_A,
      siteId: SITE_1,
      revision: 1,
      publisherId: 'admin-1',
    });
    expect(appendAdminAudit).toHaveBeenCalledWith(
      'experience.published',
      { type: 'reception_experience', id: 'tenant-a:site-1' },
      { tenantId: 'tenant-a', siteId: 'site-1', revision: '1', configHash: 'sha256:aaa' },
    );
  });

  it('viewer は書き込めない（403・サービスを呼ばない）', async () => {
    requireActorWithIdentity.mockResolvedValue({ actor: VIEWER_A, identity: 'viewer-1' });

    const res = await POST(
      post({ tenantId: 'tenant-a', siteId: 'site-1', action: 'publish', revision: 1 }),
    );

    expect(res.status).toBe(403);
    expect(service.publish).not.toHaveBeenCalled();
    expect(appendAdminAudit).not.toHaveBeenCalled();
  });

  it('別テナントの拠点へは書けない（403）', async () => {
    const res = await POST(
      post({ tenantId: 'tenant-b', siteId: 'site-1', action: 'publish', revision: 1 }),
    );

    expect(res.status).toBe(403);
  });

  it('未知の action は 400', async () => {
    const res = await POST(post({ tenantId: 'tenant-a', siteId: 'site-1', action: 'destroy' }));
    expect(res.status).toBe(400);
  });

  it('kioskId 未指定なら拠点の代表端末で構成を解決する（暫定 ID を持ち込まない）', async () => {
    const res = await POST(post({ tenantId: 'tenant-a', siteId: 'site-1', action: 'save-draft' }));

    expect(res.status).toBe(200);
    expect(service.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ kioskId: 'kiosk-1' }),
    );
  });

  it('拠点に端末が 1 台も無ければ 409（版を作らない）', async () => {
    resolveRepresentativeKioskId.mockResolvedValue(null);

    const res = await POST(post({ tenantId: 'tenant-a', siteId: 'site-1', action: 'save-draft' }));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: 'no_device_in_site' });
    expect(service.saveDraft).not.toHaveBeenCalled();
  });

  it('save-draft は編集者 identity で下書きを保存する', async () => {
    const res = await POST(
      post({ tenantId: 'tenant-a', siteId: 'site-1', action: 'save-draft', kioskId: 'kiosk-1' }),
    );

    expect(res.status).toBe(200);
    expect(service.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ kioskId: 'kiosk-1', editorId: 'admin-1' }),
    );
    expect(appendAdminAudit).toHaveBeenCalledWith(
      'experience.draft_saved',
      expect.anything(),
      expect.anything(),
    );
  });

  it('revision が不正な承認/公開/切り戻しは 400', async () => {
    for (const action of ['approve', 'publish', 'rollback']) {
      const res = await POST(post({ tenantId: 'tenant-a', siteId: 'site-1', action, revision: 0 }));
      expect(res.status).toBe(400);
    }
  });

  it('検証エラーによる承認拒否は 422、競合は 409、構成取得失敗は 503', async () => {
    service.approve.mockResolvedValue({ ok: false, reason: 'validation_failed' });
    expect(
      (await POST(post({ tenantId: 'tenant-a', siteId: 'site-1', action: 'approve', revision: 1 })))
        .status,
    ).toBe(422);

    service.publish.mockResolvedValue({ ok: false, reason: 'not_approved' });
    expect(
      (await POST(post({ tenantId: 'tenant-a', siteId: 'site-1', action: 'publish', revision: 1 })))
        .status,
    ).toBe(409);

    service.saveDraft.mockResolvedValue({ ok: false, reason: 'snapshot_failed' });
    expect(
      (
        await POST(
          post({ tenantId: 'tenant-a', siteId: 'site-1', action: 'save-draft', kioskId: 'k1' }),
        )
      ).status,
    ).toBe(503);
  });

  it('失敗時は監査を残さない', async () => {
    service.publish.mockResolvedValue({ ok: false, reason: 'not_approved' });

    await POST(post({ tenantId: 'tenant-a', siteId: 'site-1', action: 'publish', revision: 1 }));

    expect(appendAdminAudit).not.toHaveBeenCalled();
  });
});
