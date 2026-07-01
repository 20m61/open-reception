import { describe, expect, it } from 'vitest';
import {
  adminRoleToTenantRole,
  buildActorConfig,
  buildActorFromAdminUser,
  buildActorFromEntraRoles,
  buildActorFromPasswordSession,
  buildAssignment,
  resolveActorFromStore,
  type ActorConfig,
} from './actor';
import { canEnterArea } from '@/domain/auth/route-guard';
import { asAdminUserId, asTenantId, type AdminUser } from '@/domain/tenant/types';
import type { AdminUserRepository } from '@/lib/tenant/repository';

const baseConfig: ActorConfig = {
  defaultTenantId: 'default',
  defaultSiteId: undefined,
  passwordRole: 'tenant_admin',
  developerEmails: new Set<string>(),
  entraUnregistered: 'deny',
};

const withSite: ActorConfig = { ...baseConfig, defaultSiteId: 'site-1' };

describe('adminRoleToTenantRole', () => {
  it('Admin → tenant_admin', () => {
    expect(adminRoleToTenantRole('Admin')).toBe('tenant_admin');
  });
  it('SiteManager → site_manager', () => {
    expect(adminRoleToTenantRole('SiteManager')).toBe('site_manager');
  });
  it('Viewer → viewer', () => {
    expect(adminRoleToTenantRole('Viewer')).toBe('viewer');
  });
  it('developer は AdminRole から自動付与されない（写像に存在しない）', () => {
    // AdminRole 型に developer は無い。写像の値域に developer が含まれないことを確認。
    const values = (['Admin', 'SiteManager', 'Viewer'] as const).map(adminRoleToTenantRole);
    expect(values).not.toContain('developer');
  });
});

describe('buildAssignment', () => {
  it('tenant_admin は siteId null・tenantId 付き', () => {
    const a = buildAssignment('tenant_admin', baseConfig);
    expect(a).toEqual({ role: 'tenant_admin', tenantId: 'default', siteId: null, deviceId: null });
  });
  it('site_manager は claim siteId を優先する', () => {
    const a = buildAssignment('site_manager', baseConfig, 'site-from-claim');
    expect(a?.siteId).toBe('site-from-claim');
  });
  it('site_manager は claim 無ければ config.defaultSiteId を使う', () => {
    const a = buildAssignment('site_manager', withSite);
    expect(a?.siteId).toBe('site-1');
  });
  it('site_manager は siteId を確定できなければ null', () => {
    expect(buildAssignment('site_manager', baseConfig)).toBeNull();
  });
});

describe('buildActorFromEntraRoles', () => {
  it('Admin ロール → tenant_admin の actor', () => {
    const actor = buildActorFromEntraRoles(['OpenReception.Admin'], baseConfig);
    expect(actor).toEqual({
      status: 'active',
      assignments: [{ role: 'tenant_admin', tenantId: 'default', siteId: null, deviceId: null }],
    });
  });

  it('roles claim が無ければ null', () => {
    expect(buildActorFromEntraRoles(undefined, baseConfig)).toBeNull();
    expect(buildActorFromEntraRoles([], baseConfig)).toBeNull();
    expect(buildActorFromEntraRoles(['UnknownRole'], baseConfig)).toBeNull();
  });

  it('developer は roles claim だけでは自動付与されない', () => {
    const actor = buildActorFromEntraRoles(['OpenReception.Admin'], baseConfig, {
      email: 'someone@example.com',
    });
    expect(actor?.assignments.some((a) => a.role === 'developer')).toBe(false);
  });

  it('email が allowlist にあれば developer を追加付与する（大文字小文字無視）', () => {
    const cfg: ActorConfig = {
      ...baseConfig,
      developerEmails: new Set(['dev@example.com']),
    };
    const actor = buildActorFromEntraRoles(['OpenReception.Admin'], cfg, {
      email: 'DEV@Example.com',
    });
    expect(actor?.assignments.some((a) => a.role === 'developer')).toBe(true);
    expect(actor?.assignments.some((a) => a.role === 'tenant_admin')).toBe(true);
  });

  it('SiteManager は siteId を確定できなければ割り当てが作れず null', () => {
    const actor = buildActorFromEntraRoles(['OpenReception.SiteManager'], baseConfig);
    expect(actor).toBeNull();
  });

  it('SiteManager は defaultSiteId があれば site_manager の actor', () => {
    const actor = buildActorFromEntraRoles(['OpenReception.SiteManager'], withSite);
    expect(actor?.assignments).toEqual([
      { role: 'site_manager', tenantId: 'default', siteId: 'site-1', deviceId: null },
    ]);
  });
});

describe('buildActorFromPasswordSession', () => {
  it('既定（tenant_admin）の actor を返す', () => {
    const actor = buildActorFromPasswordSession(baseConfig);
    expect(actor?.assignments).toEqual([
      { role: 'tenant_admin', tenantId: 'default', siteId: null, deviceId: null },
    ]);
  });

  it('passwordRole=developer の明示時のみ developer を返す', () => {
    const actor = buildActorFromPasswordSession({ ...baseConfig, passwordRole: 'developer' });
    expect(actor?.assignments).toEqual([
      { role: 'developer', tenantId: null, siteId: null, deviceId: null },
    ]);
  });

  it('passwordRole=site_manager で siteId を確定できなければ null', () => {
    const actor = buildActorFromPasswordSession({ ...baseConfig, passwordRole: 'site_manager' });
    expect(actor).toBeNull();
  });
});

describe('buildActorConfig', () => {
  it('未設定時の既定（internal tenant / default-site / tenant_admin / 空 allowlist）', () => {
    const cfg = buildActorConfig({});
    // 既定はプロビジョニング済みテナント（lib/tenant/store.ts）と一致させる（#171）。
    expect(cfg.defaultTenantId).toBe('internal');
    expect(cfg.defaultSiteId).toBe('default-site');
    expect(cfg.passwordRole).toBe('tenant_admin');
    expect(cfg.developerEmails.size).toBe(0);
  });

  it('env から境界・allowlist を読む', () => {
    const cfg = buildActorConfig({
      OPEN_RECEPTION_DEFAULT_TENANT_ID: 'acme',
      OPEN_RECEPTION_DEFAULT_SITE_ID: 'hq',
      OPEN_RECEPTION_ADMIN_PASSWORD_ROLE: 'developer',
      OPEN_RECEPTION_PLATFORM_DEVELOPER_EMAILS: 'A@x.com, b@x.com',
    });
    expect(cfg.defaultTenantId).toBe('acme');
    expect(cfg.defaultSiteId).toBe('hq');
    expect(cfg.passwordRole).toBe('developer');
    expect(cfg.developerEmails.has('a@x.com')).toBe(true);
    expect(cfg.developerEmails.has('b@x.com')).toBe(true);
  });

  it('不正な passwordRole は安全側の tenant_admin に倒す', () => {
    const cfg = buildActorConfig({ OPEN_RECEPTION_ADMIN_PASSWORD_ROLE: 'superuser' });
    expect(cfg.passwordRole).toBe('tenant_admin');
  });
});

describe('canEnterArea × 解決済み actor の組み合わせ', () => {
  it('password 既定（tenant_admin）は /admin に入れるが /platform は不可', () => {
    const actor = buildActorFromPasswordSession(baseConfig)!;
    expect(canEnterArea(actor, 'admin').allowed).toBe(true);
    expect(canEnterArea(actor, 'platform').allowed).toBe(false);
  });

  it('developer 設定の actor は /admin・/platform の両方に入れる', () => {
    const actor = buildActorFromPasswordSession({ ...baseConfig, passwordRole: 'developer' })!;
    expect(canEnterArea(actor, 'admin').allowed).toBe(true);
    expect(canEnterArea(actor, 'platform').allowed).toBe(true);
  });

  it('Entra Viewer は /admin に入れるが /platform は不可', () => {
    const actor = buildActorFromEntraRoles(['OpenReception.Viewer'], baseConfig)!;
    expect(canEnterArea(actor, 'admin').allowed).toBe(true);
    expect(canEnterArea(actor, 'platform').allowed).toBe(false);
  });

  it('Entra Admin + developer allowlist は /platform に入れる', () => {
    const cfg: ActorConfig = { ...baseConfig, developerEmails: new Set(['dev@x.com']) };
    const actor = buildActorFromEntraRoles(['OpenReception.Admin'], cfg, { email: 'dev@x.com' })!;
    expect(canEnterArea(actor, 'platform').allowed).toBe(true);
  });

  it('null actor（未認証）はどのエリアにも入れない', () => {
    expect(canEnterArea(null, 'admin').allowed).toBe(false);
    expect(canEnterArea(null, 'platform').allowed).toBe(false);
  });
});

/* ===================== AdminUser ストアによる実 actor 解決（increment 2） ===================== */

const now = '2026-06-20T00:00:00.000Z';

function adminUser(over: Partial<AdminUser> = {}): AdminUser {
  return {
    id: asAdminUserId('u1'),
    entraSubject: 'oid-1',
    email: 'user@acme.com',
    displayName: 'User',
    assignments: [{ role: 'tenant_admin', tenantId: asTenantId('acme'), siteId: null, deviceId: null }],
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe('buildActorFromAdminUser', () => {
  it('実 assignments をそのまま正とする（env 既定テナントへ束ねない）', () => {
    const actor = buildActorFromAdminUser(adminUser(), baseConfig);
    expect(actor?.assignments).toEqual([
      { role: 'tenant_admin', tenantId: 'acme', siteId: null, deviceId: null },
    ]);
  });

  it('suspended ユーザーは拒否（null）', () => {
    expect(buildActorFromAdminUser(adminUser({ status: 'suspended' }), baseConfig)).toBeNull();
  });

  it('assignments が空なら null', () => {
    expect(buildActorFromAdminUser(adminUser({ assignments: [] }), baseConfig)).toBeNull();
  });

  it('email が developer allowlist にあれば developer を追加付与', () => {
    const cfg: ActorConfig = { ...baseConfig, developerEmails: new Set(['dev@acme.com']) };
    const actor = buildActorFromAdminUser(adminUser({ email: 'DEV@acme.com' }), cfg);
    expect(actor?.assignments.some((a) => a.role === 'developer')).toBe(true);
    expect(actor?.assignments.some((a) => a.role === 'tenant_admin')).toBe(true);
  });
});

/** subject/email で 1 件返すだけの最小 fake リポジトリ。 */
function fakeRepo(users: AdminUser[]): AdminUserRepository {
  return {
    async getAdminUser(id) {
      return users.find((u) => u.id === id);
    },
    async findBySubject(subject) {
      return subject ? users.find((u) => u.entraSubject === subject) : undefined;
    },
    async findByEmail(email) {
      const n = email.trim().toLowerCase();
      return n ? users.find((u) => u.email.toLowerCase() === n) : undefined;
    },
    async putAdminUser() {},
  };
}

describe('resolveActorFromStore', () => {
  it('subject で実 AdminUser を解決し実 assignments で actor を作る', async () => {
    const repo = fakeRepo([adminUser({ entraSubject: 'oid-99' })]);
    const actor = await resolveActorFromStore({ subject: 'oid-99' }, baseConfig, repo);
    expect(actor?.assignments).toEqual([
      { role: 'tenant_admin', tenantId: 'acme', siteId: null, deviceId: null },
    ]);
  });

  it('subject で引けない場合は email で補助解決する', async () => {
    const repo = fakeRepo([adminUser({ entraSubject: 'oid-other', email: 'who@acme.com' })]);
    const actor = await resolveActorFromStore(
      { subject: 'unknown', email: 'who@acme.com' },
      baseConfig,
      repo,
    );
    expect(actor?.assignments[0]?.tenantId).toBe('acme');
  });

  it('未登録ユーザーは既定（deny）で null＝最小権限', async () => {
    const repo = fakeRepo([]);
    const actor = await resolveActorFromStore(
      { subject: 'nobody', email: 'nobody@x.com', rolesClaim: ['OpenReception.Admin'] },
      baseConfig,
      repo,
    );
    expect(actor).toBeNull();
  });

  it('entraUnregistered=env_roles なら未登録でも env 既定境界で actor を作る（後方互換）', async () => {
    const repo = fakeRepo([]);
    const cfg: ActorConfig = { ...baseConfig, entraUnregistered: 'env_roles' };
    const actor = await resolveActorFromStore(
      { subject: 'nobody', email: 'nobody@x.com', rolesClaim: ['OpenReception.Admin'] },
      cfg,
      repo,
    );
    expect(actor?.assignments).toEqual([
      { role: 'tenant_admin', tenantId: 'default', siteId: null, deviceId: null },
    ]);
  });

  it('suspended な登録ユーザーは拒否（null）', async () => {
    const repo = fakeRepo([adminUser({ entraSubject: 'oid-sus', status: 'suspended' })]);
    const actor = await resolveActorFromStore({ subject: 'oid-sus' }, baseConfig, repo);
    expect(actor).toBeNull();
  });
});

describe('buildActorConfig entraUnregistered', () => {
  it('既定は deny（最小権限）', () => {
    expect(buildActorConfig({}).entraUnregistered).toBe('deny');
  });
  it('env_roles を明示した時のみ後方互換モード', () => {
    expect(buildActorConfig({ OPEN_RECEPTION_ENTRA_UNREGISTERED: 'env_roles' }).entraUnregistered).toBe(
      'env_roles',
    );
    expect(buildActorConfig({ OPEN_RECEPTION_ENTRA_UNREGISTERED: 'bogus' }).entraUnregistered).toBe(
      'deny',
    );
  });
});
