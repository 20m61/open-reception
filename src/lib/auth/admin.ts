/**
 * 管理画面認証の設定 (issue #24)。
 * secret / password は server-only な環境変数で扱う（NEXT_PUBLIC_ を付けない）。
 * 開発・ローカル e2e 用の既定値を持つが、本番では必ず環境変数で上書きする。
 */
export const ADMIN_COOKIE = 'admin_session';
/** Entra ログイン後のアクセストークンを保持する cookie (issue #70)。 */
export const ENTRA_TOKEN_COOKIE = 'admin_entra_token';
/** OIDC ログインの PKCE verifier / state（短命・httpOnly） (issue #70)。 */
export const ENTRA_VERIFIER_COOKIE = 'admin_entra_verifier';
export const ENTRA_STATE_COOKIE = 'admin_entra_state';

/** 管理セッションの有効期間（8 時間）。 */
export const ADMIN_SESSION_TTL_MS = 1000 * 60 * 60 * 8;

export function getAdminSecret(): string {
  return process.env.ADMIN_SESSION_SECRET ?? 'dev-insecure-admin-secret';
}

export function getAdminPassword(): string {
  return process.env.ADMIN_PASSWORD ?? 'open-reception';
}
