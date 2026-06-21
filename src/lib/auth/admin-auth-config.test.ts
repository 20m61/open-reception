import { describe, expect, it } from 'vitest';
import {
  deriveJwksUri,
  describeAdminAuthStatus,
  getAdminAuthConfig,
  validateAdminAuthConfig,
} from './admin-auth-config';

describe('getAdminAuthConfig (#70)', () => {
  it('既定は none・常に required（既存パスワード認証を維持）', () => {
    const cfg = getAdminAuthConfig({});
    expect(cfg.provider).toBe('none');
    expect(cfg.required).toBe(true);
  });

  it('none では ADMIN_AUTH_REQUIRED=false でも required を維持する', () => {
    const cfg = getAdminAuthConfig({ ADMIN_AUTH_REQUIRED: 'false' });
    expect(cfg.provider).toBe('none');
    expect(cfg.required).toBe(true);
  });

  it('entra 設定を読み取り JWKS URI を導出する', () => {
    const cfg = getAdminAuthConfig({
      ADMIN_AUTH_PROVIDER: 'entra',
      ENTRA_TENANT_ID: 'tenant-1',
      ENTRA_CLIENT_ID: 'client-1',
      ENTRA_AUDIENCE: 'api://client-1',
      ADMIN_ALLOWED_ROLES: 'OpenReception.Admin',
    });
    expect(cfg.provider).toBe('entra');
    expect(cfg.required).toBe(true);
    expect(cfg.entra?.issuer).toBe('https://login.microsoftonline.com/tenant-1/v2.0');
    expect(cfg.entra?.audience).toBe('api://client-1');
    expect(cfg.entra?.jwksUri).toBe('https://login.microsoftonline.com/tenant-1/discovery/v2.0/keys');
    expect(cfg.entra?.allowedRoles.has('Admin')).toBe(true);
    expect(cfg.entra?.allowedRoles.has('Viewer')).toBe(false);
  });

  it('audience 未指定は client_id にフォールバックする', () => {
    const cfg = getAdminAuthConfig({
      ADMIN_AUTH_PROVIDER: 'entra',
      ENTRA_ISSUER: 'https://login.microsoftonline.com/t/v2.0',
      ENTRA_CLIENT_ID: 'client-x',
    });
    expect(cfg.entra?.audience).toBe('client-x');
  });
});

describe('deriveJwksUri (#70)', () => {
  it('issuer から導出する', () => {
    expect(deriveJwksUri('https://login.microsoftonline.com/t/v2.0')).toBe(
      'https://login.microsoftonline.com/t/discovery/v2.0/keys',
    );
  });
});

describe('validateAdminAuthConfig (#70)', () => {
  it('本番で認証無効化(required=false)はエラー', () => {
    const check = validateAdminAuthConfig({ provider: 'entra', required: false, entra: undefined }, 'production');
    expect(check.ok).toBe(false);
    expect(check.errors.join(' ')).toContain('無効化');
  });

  it('開発で required=false は警告のみ', () => {
    const check = validateAdminAuthConfig({ provider: 'entra', required: false }, 'development');
    expect(check.warnings.length).toBeGreaterThan(0);
    // entra 必須値欠落は別途エラーになる
    expect(check.errors.some((e) => e.includes('ENTRA'))).toBe(true);
  });

  it('entra で issuer/audience があれば ok', () => {
    const check = validateAdminAuthConfig(
      {
        provider: 'entra',
        required: true,
        entra: {
          issuer: 'https://issuer/v2.0',
          audience: 'aud',
          jwksUri: 'https://issuer/discovery/v2.0/keys',
          allowedRoles: new Set(['Admin']),
        },
      },
      'production',
    );
    expect(check.ok).toBe(true);
  });

  it('none + required は常に ok', () => {
    expect(validateAdminAuthConfig({ provider: 'none', required: true }, 'production').ok).toBe(true);
  });

  it('entra で clientId 欠落は警告（ログイン導線不能）だが ok は維持', () => {
    const check = validateAdminAuthConfig(
      {
        provider: 'entra',
        required: true,
        entra: {
          issuer: 'https://issuer/v2.0',
          audience: 'aud',
          jwksUri: 'https://issuer/discovery/v2.0/keys',
          allowedRoles: new Set(['Admin']),
        },
      },
      'production',
    );
    expect(check.ok).toBe(true);
    expect(check.warnings.some((w) => w.includes('ENTRA_CLIENT_ID'))).toBe(true);
  });
});

describe('describeAdminAuthStatus (#70)', () => {
  it('provider=none は entra 詳細を持たない', () => {
    const s = describeAdminAuthStatus({});
    expect(s.provider).toBe('none');
    expect(s.required).toBe(true);
    expect(s.ok).toBe(true);
    expect(s.entra).toBeUndefined();
  });

  it('entra 設定の有無を値を含めずに表す', () => {
    const s = describeAdminAuthStatus({
      ADMIN_AUTH_PROVIDER: 'entra',
      ENTRA_TENANT_ID: 'tenant-1',
      ENTRA_CLIENT_ID: 'client-1',
      ENTRA_AUDIENCE: 'api://client-1',
      ADMIN_ALLOWED_ROLES: 'OpenReception.Admin,OpenReception.Viewer',
      NODE_ENV: 'production',
    });
    expect(s.provider).toBe('entra');
    expect(s.entra).toBeDefined();
    const byKey = Object.fromEntries((s.entra?.settings ?? []).map((x) => [x.key, x.presence]));
    expect(byKey.issuer).toBe('set');
    expect(byKey.audience).toBe('set');
    expect(byKey.jwksUri).toBe('set');
    expect(byKey.clientId).toBe('set');
    expect(byKey.allowedRoles).toBe('set');
    expect(s.entra?.allowedRoles).toEqual(expect.arrayContaining(['Admin', 'Viewer']));
  });

  it('機密値そのもの（issuer/clientId 等）を JSON に含めない', () => {
    const s = describeAdminAuthStatus({
      ADMIN_AUTH_PROVIDER: 'entra',
      ENTRA_TENANT_ID: 'secret-tenant-xyz',
      ENTRA_CLIENT_ID: 'secret-client-abc',
      NODE_ENV: 'production',
    });
    const json = JSON.stringify(s);
    expect(json).not.toContain('secret-tenant-xyz');
    expect(json).not.toContain('secret-client-abc');
    expect(json).not.toContain('login.microsoftonline.com');
  });

  it('entra 必須値欠落は presence=missing として表す', () => {
    const s = describeAdminAuthStatus({ ADMIN_AUTH_PROVIDER: 'entra', NODE_ENV: 'production' });
    const byKey = Object.fromEntries((s.entra?.settings ?? []).map((x) => [x.key, x.presence]));
    expect(byKey.issuer).toBe('missing');
    expect(byKey.clientId).toBe('missing');
    expect(s.ok).toBe(false);
  });
});
