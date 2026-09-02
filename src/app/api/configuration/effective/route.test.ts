/**
 * GET /api/configuration/effective のテスト (#419)。
 *
 * 端末実行（kiosk セッション）と管理プレビュー（admin actor）で**同じ resolver**を通し、
 * 越境指定が 403 になること・端末が query を信用されないことを固定する。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireKioskSession = vi.fn();
const resolveDeviceBinding = vi.fn();
const resolveAdminActorWithIdentity = vi.fn();
const createSectionLoaders = vi.fn();
const getBySite = vi.fn();

vi.mock('@/lib/kiosk/session-guard', () => ({
  requireKioskSession: () => requireKioskSession(),
}));
vi.mock('@/lib/product-context/device-binding', async () => {
  const actual = await vi.importActual<typeof import('@/lib/product-context/device-binding')>(
    '@/lib/product-context/device-binding',
  );
  return { ...actual, resolveDeviceBinding: (...a: unknown[]) => resolveDeviceBinding(...a) };
});
vi.mock('@/lib/auth/actor', () => ({
  resolveAdminActorWithIdentity: () => resolveAdminActorWithIdentity(),
}));
vi.mock('@/lib/product-context/section-loaders', () => ({
  createSectionLoaders: () => createSectionLoaders(),
}));
vi.mock('@/lib/experience-version/store', () => ({
  getExperienceVersionService: () => ({ getBySite: (...a: unknown[]) => getBySite(...a) }),
}));

import { GET } from './route';
import { CONFIGURATION_SECTIONS } from '@/domain/product-context/types';
import { asSiteId, asTenantId, type RoleAssignment } from '@/domain/tenant/types';

const BINDING = {
  tenantId: asTenantId('tenant-a'),
  siteId: asSiteId('site-1'),
  kioskId: 'kiosk-1',
};

function adminActor(assignments: RoleAssignment[]) {
  return { actor: { status: 'active' as const, assignments }, identity: 'admin-1' };
}

function tenantAdminOf(tenantId: string): RoleAssignment {
  return { role: 'tenant_admin', tenantId: asTenantId(tenantId), siteId: null, deviceId: null };
}

/** 全セクションを固定値で返すローダ集合。 */
function stubLoaders(over: Record<string, unknown> = {}) {
  const loaders: Record<string, unknown> = {};
  for (const s of CONFIGURATION_SECTIONS) {
    loaders[s] = over[s] ?? (async () => ({ value: { section: s }, source: 'default' }));
  }
  return loaders;
}

function request(query = ''): Request {
  return new Request(`https://example.com/api/configuration/effective${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireKioskSession.mockResolvedValue(null);
  resolveDeviceBinding.mockResolvedValue(BINDING);
  resolveAdminActorWithIdentity.mockResolvedValue(null);
  createSectionLoaders.mockReturnValue(stubLoaders());
  // 既定は「版管理をまだ使っていない拠点」= live 配信。
  getBySite.mockResolvedValue(undefined);
});

describe('端末実行（kiosk セッション）', () => {
  beforeEach(() => {
    requireKioskSession.mockResolvedValue({ kioskId: 'kiosk-1' });
  });

  it('セッション端末の実効構成を返す（由来・指紋つき）', async () => {
    const res = await GET(request());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.context).toEqual({ tenantId: 'tenant-a', siteId: 'site-1', kioskId: 'kiosk-1' });
    expect(body.version).toMatchObject({ id: 'live', status: 'published', revision: 0 });
    expect(body.configHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.keys(body.provenance).sort()).toEqual([...CONFIGURATION_SECTIONS].sort());
  });

  it('query の tenant/site/kiosk を信用しない（セッション束縛が権威）', async () => {
    const res = await GET(request('?tenantId=tenant-b&siteId=site-9&kioskId=kiosk-9'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.context).toEqual({ tenantId: 'tenant-a', siteId: 'site-1', kioskId: 'kiosk-1' });
    expect(resolveDeviceBinding).toHaveBeenCalledWith('kiosk-1');
  });

  it('未登録・失効した端末は 403（既定テナントの構成を配らない）', async () => {
    resolveDeviceBinding.mockResolvedValue(null);

    const res = await GET(request());

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: 'device_not_registered' });
  });

  it('端末は draft を要求できない（403）', async () => {
    const res = await GET(request('?version=draft'));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: 'draft_not_allowed' });
  });
});

describe('管理プレビュー（admin actor）', () => {
  beforeEach(() => {
    resolveAdminActorWithIdentity.mockResolvedValue(adminActor([tenantAdminOf('tenant-a')]));
  });

  it('自テナントの端末をプレビューできる', async () => {
    const res = await GET(request('?tenantId=tenant-a&siteId=site-1&kioskId=kiosk-1'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.context).toEqual({ tenantId: 'tenant-a', siteId: 'site-1', kioskId: 'kiosk-1' });
  });

  it('別テナントの指定は 403', async () => {
    const res = await GET(request('?tenantId=tenant-b&siteId=site-1&kioskId=kiosk-1'));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: 'cross_tenant' });
  });

  it('スコープが欠けていれば 400', async () => {
    const res = await GET(request('?tenantId=tenant-a'));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'scope_required' });
  });

  it('自テナントの拠点に属さない端末 ID は 403（他テナントのフラグ値を観測させない）', async () => {
    resolveDeviceBinding.mockResolvedValue({
      tenantId: asTenantId('tenant-b'),
      siteId: asSiteId('site-9'),
      kioskId: 'kiosk-of-b',
    });

    const res = await GET(request('?tenantId=tenant-a&siteId=site-1&kioskId=kiosk-of-b'));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: 'kiosk_not_in_scope' });
  });

  it('同テナントでも別拠点の端末なら 403', async () => {
    resolveDeviceBinding.mockResolvedValue({
      tenantId: asTenantId('tenant-a'),
      siteId: asSiteId('site-2'),
      kioskId: 'kiosk-2',
    });

    const res = await GET(request('?tenantId=tenant-a&siteId=site-1&kioskId=kiosk-2'));

    expect(res.status).toBe(403);
  });

  it('未登録の端末 ID は 403', async () => {
    resolveDeviceBinding.mockResolvedValue(null);

    const res = await GET(request('?tenantId=tenant-a&siteId=site-1&kioskId=kiosk-x'));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: 'kiosk_not_in_scope' });
  });

  it('未認証は 401', async () => {
    resolveAdminActorWithIdentity.mockResolvedValue(null);

    const res = await GET(request('?tenantId=tenant-a&siteId=site-1&kioskId=kiosk-1'));

    expect(res.status).toBe(401);
  });

  it('版管理未導入の拠点では draft を解決しない（404）', async () => {
    const res = await GET(request('?tenantId=tenant-a&siteId=site-1&kioskId=kiosk-1&version=draft'));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: 'version_not_found' });
  });

  it('プレビューと端末実行で同じ configHash になる（AC1）', async () => {
    const preview = await GET(request('?tenantId=tenant-a&siteId=site-1&kioskId=kiosk-1'));
    const previewBody = await preview.json();

    requireKioskSession.mockResolvedValue({ kioskId: 'kiosk-1' });
    const runtime = await GET(request());
    const runtimeBody = await runtime.json();

    expect(previewBody.configHash).toBe(runtimeBody.configHash);
  });
});

describe('版のスナップショット配信（#420 Inc2）', () => {
  /** rev1 = 公開（スナップショット付き）、rev2 = 下書き。 */
  const experience = {
    id: 'tenant-a:site-1',
    tenantId: asTenantId('tenant-a'),
    siteId: asSiteId('site-1'),
    name: '本社受付',
    updatedAt: '2026-07-27T00:00:00.000Z',
    versions: [
      {
        revision: 1,
        status: 'published' as const,
        configHash: 'sha256:published-content',
        snapshot: {
          sections: { branding: { accentColor: '#published' } },
          provenance: { branding: 'tenant' },
          configHash: 'sha256:published-content',
        },
        createdBy: 'admin-1',
        createdAt: '2026-07-27T00:00:00.000Z',
        publishedBy: 'admin-2',
        publishedAt: '2026-07-27T01:00:00.000Z',
      },
      {
        revision: 2,
        status: 'draft' as const,
        configHash: 'sha256:draft-content',
        snapshot: {
          sections: { branding: { accentColor: '#draft' } },
          provenance: { branding: 'tenant' },
          configHash: 'sha256:draft-content',
        },
        createdBy: 'admin-1',
        createdAt: '2026-07-27T02:00:00.000Z',
      },
    ],
  };

  beforeEach(() => {
    getBySite.mockResolvedValue(experience);
    // live ストアは「編集後」の値を返す。スナップショット配信ならこれは出てこない。
    createSectionLoaders.mockReturnValue(
      stubLoaders({ branding: async () => ({ value: { accentColor: '#live-edit' }, source: 'tenant' }) }),
    );
  });

  it('端末には公開版のスナップショットを配る（live ストアの編集は届かない）', async () => {
    requireKioskSession.mockResolvedValue({ kioskId: 'kiosk-1' });

    const res = await GET(request());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.branding).toEqual({ accentColor: '#published' });
    expect(body.version).toMatchObject({ id: 'tenant-a:site-1#1', revision: 1 });
    expect(body.provenance.branding).toBe('tenant');
  });

  it('プレビューで draft を指定すると下書きのスナップショットが出る', async () => {
    resolveAdminActorWithIdentity.mockResolvedValue(adminActor([tenantAdminOf('tenant-a')]));

    const res = await GET(request('?tenantId=tenant-a&siteId=site-1&kioskId=kiosk-1&version=draft'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.branding).toEqual({ accentColor: '#draft' });
    expect(body.version).toMatchObject({ revision: 2, status: 'draft' });
  });

  it('端末は draft 版を要求できない（403 のまま）', async () => {
    requireKioskSession.mockResolvedValue({ kioskId: 'kiosk-1' });

    const res = await GET(request('?version=draft'));

    expect(res.status).toBe(403);
  });

  it('スナップショット取得後に増えたセクションは空で配る（欠落で全体を落とさない）', async () => {
    requireKioskSession.mockResolvedValue({ kioskId: 'kiosk-1' });

    const body = await (await GET(request())).json();

    expect(body.voice).toEqual({});
    expect(body.provenance.voice).toBe('default');
  });

  it('公開版が無く下書きだけの拠点は、公開構成として live へ倒さない（404）', async () => {
    getBySite.mockResolvedValue({
      ...experience,
      versions: [{ ...experience.versions[1], revision: 1 }],
    });
    requireKioskSession.mockResolvedValue({ kioskId: 'kiosk-1' });

    const res = await GET(request());

    expect(res.status).toBe(404);
  });
});

describe('セクション障害・秘匿混入', () => {
  beforeEach(() => {
    resolveAdminActorWithIdentity.mockResolvedValue(adminActor([tenantAdminOf('tenant-a')]));
  });

  it('セクションのローダが失敗したら 503（部分構成を返さない）', async () => {
    createSectionLoaders.mockReturnValue(
      stubLoaders({
        branding: async () => {
          throw new Error('store down');
        },
      }),
    );

    const res = await GET(request('?tenantId=tenant-a&siteId=site-1&kioskId=kiosk-1'));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: 'section_unavailable',
      section: 'branding',
    });
  });

  it('秘匿値が混入したら 500 で拒否し、値もキーのパスも応答へ出さない', async () => {
    createSectionLoaders.mockReturnValue(
      stubLoaders({
        voice: async () => ({ value: { apiKey: 'TEST-leak' }, source: 'tenant' }),
      }),
    );

    const res = await GET(request('?tenantId=tenant-a&siteId=site-1&kioskId=kiosk-1'));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'configuration_rejected', section: 'voice' });
    expect(JSON.stringify(body)).not.toContain('TEST-leak');
    expect(JSON.stringify(body)).not.toContain('apiKey');
  });
});
