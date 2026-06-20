import { describe, expect, it } from 'vitest';
import {
  adminRoleToTenantRole,
  buildActorConfig,
  buildActorFromEntraRoles,
  buildActorFromPasswordSession,
  buildAssignment,
  type ActorConfig,
} from './actor';
import { canEnterArea } from '@/components/admin/route-guard';

const baseConfig: ActorConfig = {
  defaultTenantId: 'default',
  defaultSiteId: undefined,
  passwordRole: 'tenant_admin',
  developerEmails: new Set<string>(),
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
  it('未設定時の既定（default tenant / tenant_admin / 空 allowlist）', () => {
    const cfg = buildActorConfig({});
    expect(cfg.defaultTenantId).toBe('default');
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
