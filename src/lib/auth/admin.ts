/**
 * 管理画面認証の設定 (issue #24)。
 * secret / password は server-only な環境変数で扱う（NEXT_PUBLIC_ を付けない）。
 * 開発・ローカル e2e 用の既定値を持つが、本番では必ず環境変数で上書きする。
 */
import { serverSecret } from './server-secret';

export const ADMIN_COOKIE = 'admin_session';
/** Entra ログイン後のアクセストークンを保持する cookie (issue #70)。 */
export const ENTRA_TOKEN_COOKIE = 'admin_entra_token';
/** OIDC ログインの PKCE verifier / state（短命・httpOnly） (issue #70)。 */
export const ENTRA_VERIFIER_COOKIE = 'admin_entra_verifier';
export const ENTRA_STATE_COOKIE = 'admin_entra_state';

/** 管理セッションの有効期間（8 時間）。 */
export const ADMIN_SESSION_TTL_MS = 1000 * 60 * 60 * 8;

/**
 * 管理セッションの署名鍵。**deploy 環境で未設定・公開既定値なら throw する** (#1124)。
 *
 * 以前は warn-only で、鍵を入れ忘れたデプロイでは公開既定値で署名した `admin_session`
 * cookie が有効な管理セッションとして通った（provider が cognito / entra でも、
 * `resolveAdminActorWithIdentity` は password セッションを優先するので同じ）。
 *
 * 🔴 **middleware（`src/proxy.ts`）は `register()` より先に走る**（#612）。方式 B で
 * 供給したコールドインスタンスでは、最初の admin 系リクエストの時点でまだ解決されていない。
 * proxy はこの throw を「セッション無し」として扱い、401 / ログインへ倒す
 * （以前はこの窓で**公開既定値で検証していた**）。起動時の検査は `session-secrets.ts`。
 */
export function getAdminSecret(): string {
  return serverSecret('ADMIN_SESSION_SECRET', 'dev-insecure-admin-secret', { failClosed: true });
}

/**
 * 管理パスワード。**deploy 環境で未設定なら throw する** (#1021 AC1)。
 *
 * 🔴 **既定値 `open-reception` は公開リポジトリに平文で載っている。** 既定 provider は
 * `none`（＝パスワード認証が有効）なので、`ADMIN_PASSWORD` を入れ忘れたデプロイでは
 * `POST /api/admin/login {"password":"open-reception"}` で `tenant_admin` が取れ、
 * 全テナントの設定・監査ログ・予約 PII に到達する。
 *
 * 署名鍵はすべて `serverSecret()` を通っていたのに、**最も価値の高い資格情報だけが
 * その経路を通っていなかった**。揃える。
 *
 * **`failClosed` にしてよい理由（実測）**: 本番の消費者は `/api/admin/login` の
 * `provider=none` の枝だけで、Cognito / Entra のデプロイはその手前で return する。
 * throw するのは「パスワード認証を使っているデプロイで未設定」という、まさに塞ぎたい
 * 場合に限られる。ログインは壊れるが、**公開されている既知のパスワードを受け入れるより良い**
 * —— 運用者は落ちたことに気づいて secret を入れられる。
 *
 * 🔴 **これだけでは上の脅威は閉じなかった。** 閉じたのは**パスワードという扉**だけで、
 * 同じ「秘密を入れ忘れたデプロイ」では公開既定値で署名した `admin_session` cookie が
 * 通っていた（2026-09-16 実測）。セッションという扉は #1124 で `getAdminSecret()` を
 * fail-closed にして閉じた。**どちらの鍵も必要**である。
 */
export function getAdminPassword(): string {
  return serverSecret('ADMIN_PASSWORD', 'open-reception', { failClosed: true });
}
