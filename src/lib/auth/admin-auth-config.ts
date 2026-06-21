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
    // clientId はトークン検証（JWKS）には不要だが、OIDC ログイン導線（authorize）に必須。
    // 欠落しても fail-closed には倒さず（既存トークンの検証は可能）、ログイン不能を警告で示す。
    if (!cfg.entra?.clientId) {
      warnings.push('ENTRA_CLIENT_ID が未設定です。Microsoft サインイン導線が機能しません。');
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/* ---------- 状態表示（secret/トークンを出さない） ---------- */

export type SettingPresence = 'set' | 'missing';
export type EntraSettingStatus = {
  /** 設定キー（issuer / audience / jwksUri / clientId / allowedRoles）。 */
  key: 'issuer' | 'audience' | 'jwksUri' | 'clientId' | 'allowedRoles';
  /** 設定済みか未設定か（値そのものは含めない）。 */
  presence: SettingPresence;
  /** OIDC ログイン導線に必須か（欠落で機能不全）。 */
  requiredForLogin: boolean;
};

export type AdminAuthStatus = {
  provider: AdminAuthProvider;
  required: boolean;
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** provider==='entra' のときのみ。各設定の有無（値は含めない）。 */
  entra?: {
    settings: EntraSettingStatus[];
    /** 許可ロール（公開可能な列挙値。secret ではない）。 */
    allowedRoles: AdminRole[];
  };
};

/**
 * 管理画面認証の状態を、機密値を含めずに記述する (issue #70)。
 * UI / API 用。issuer / audience / clientId などの**値は返さず**、設定の有無のみを返す。
 * allowedRoles は機密ではない列挙値のため値を返す（Client Secret / トークンは扱わない）。
 */
export function describeAdminAuthStatus(
  env: Record<string, string | undefined> = process.env,
): AdminAuthStatus {
  const cfg = getAdminAuthConfig(env);
  const check = validateAdminAuthConfig(cfg, env.NODE_ENV);
  const base: AdminAuthStatus = {
    provider: cfg.provider,
    required: cfg.required,
    ok: check.ok,
    errors: check.errors,
    warnings: check.warnings,
  };
  if (cfg.provider !== 'entra' || !cfg.entra) return base;

  const e = cfg.entra;
  const presence = (v: string | undefined): SettingPresence => (v && v.trim() ? 'set' : 'missing');
  const settings: EntraSettingStatus[] = [
    { key: 'issuer', presence: presence(e.issuer), requiredForLogin: true },
    { key: 'audience', presence: presence(e.audience), requiredForLogin: true },
    { key: 'jwksUri', presence: presence(e.jwksUri), requiredForLogin: true },
    { key: 'clientId', presence: presence(e.clientId), requiredForLogin: true },
    {
      key: 'allowedRoles',
      presence: e.allowedRoles.size > 0 ? 'set' : 'missing',
      requiredForLogin: false,
    },
  ];
  return { ...base, entra: { settings, allowedRoles: [...e.allowedRoles] } };
}
