/**
 * 管理画面認証のオプション設定 (issue #70)。
 * 既定は `none`（既存のパスワード認証を維持）。`entra` で Microsoft Entra ID の
 * JWT 検証へ置換する。secret/Client Secret はフロントに露出しない（server-only）。
 *
 *   ADMIN_AUTH_PROVIDER = none | cognito | entra   (既定: none)
 *   ADMIN_AUTH_REQUIRED = true | false             (既定: provider!=none なら true)
 *   ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_ISSUER, ENTRA_AUDIENCE
 *   ADMIN_ALLOWED_ROLES = OpenReception.Admin,OpenReception.SiteManager,OpenReception.Viewer
 */
import { parseAllowedRoles, type AdminRole } from '@/domain/auth/roles';

export type AdminAuthProvider = 'none' | 'cognito' | 'entra';

export type EntraConfig = {
  tenantId?: string;
  clientId?: string;
  issuer: string;
  audience: string;
  /** OIDC JWKS エンドポイント（issuer から導出、または明示）。 */
  jwksUri: string;
  allowedRoles: Set<AdminRole>;
};

export type AdminAuthConfig = {
  provider: AdminAuthProvider;
  required: boolean;
  entra?: EntraConfig;
};

function parseProvider(raw: string | undefined): AdminAuthProvider {
  if (raw === 'entra' || raw === 'cognito') return raw;
  return 'none';
}

/** Entra v2 の JWKS URI を issuer / tenant から導出する。 */
export function deriveJwksUri(issuer: string, tenantId?: string): string {
  // issuer 例: https://login.microsoftonline.com/{tenantId}/v2.0
  const base = issuer.replace(/\/v2\.0\/?$/, '').replace(/\/+$/, '');
  if (base) return `${base}/discovery/v2.0/keys`;
  if (tenantId) return `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`;
  return '';
}

export function getAdminAuthConfig(
  env: Record<string, string | undefined> = process.env,
): AdminAuthConfig {
  const provider = parseProvider(env.ADMIN_AUTH_PROVIDER);
  // provider=none（既存パスワード認証）は常に有効。緩和フラグは SSO のみに適用する。
  const requiredRaw = env.ADMIN_AUTH_REQUIRED;
  const required = provider === 'none' ? true : requiredRaw !== 'false';

  if (provider !== 'entra') {
    return { provider, required };
  }

  const issuer = env.ENTRA_ISSUER ?? (env.ENTRA_TENANT_ID ? `https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/v2.0` : '');
  const audience = env.ENTRA_AUDIENCE ?? env.ENTRA_CLIENT_ID ?? '';
  return {
    provider,
    required,
    entra: {
      tenantId: env.ENTRA_TENANT_ID,
      clientId: env.ENTRA_CLIENT_ID,
      issuer,
      audience,
      jwksUri: deriveJwksUri(issuer, env.ENTRA_TENANT_ID),
      allowedRoles: parseAllowedRoles(env.ADMIN_ALLOWED_ROLES),
    },
  };
}

export type ConfigCheck = { ok: boolean; errors: string[]; warnings: string[] };

/**
 * 設定の妥当性を検証する (issue #70)。
 * - 本番で認証を無効化（required=false かつ provider=none）したままにしない。
 * - entra 選択時は issuer / audience を必須にする。
 * - Client Secret はフロントに露出しない方針（PKCE 構成を優先）。
 */
export function validateAdminAuthConfig(
  cfg: AdminAuthConfig,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): ConfigCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const isProd = nodeEnv === 'production';

  if (!cfg.required) {
    const msg = '管理画面認証が無効化されています（ADMIN_AUTH_REQUIRED=false）。';
    if (isProd) errors.push(`${msg} 本番では許可されません。`);
    else warnings.push(`${msg} ローカル/PoC 用途のみ。`);
  }

  if (cfg.provider === 'entra') {
    if (!cfg.entra?.issuer) errors.push('ENTRA_ISSUER（または ENTRA_TENANT_ID）が未設定です。');
    if (!cfg.entra?.audience) errors.push('ENTRA_AUDIENCE（または ENTRA_CLIENT_ID）が未設定です。');
    if (!cfg.entra?.jwksUri) errors.push('JWKS URI を導出できません（ENTRA_ISSUER を確認）。');
  }

  return { ok: errors.length === 0, errors, warnings };
}
