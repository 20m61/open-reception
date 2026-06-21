import { getAdminAuthConfig } from '@/lib/auth/admin-auth-config';
import { AdminPasswordLogin } from '@/components/admin/AdminPasswordLogin';

/**
 * 管理画面ログイン (issue #24, #70)。
 * ADMIN_AUTH_PROVIDER=entra のときは Microsoft Entra ID のサインインへ誘導し、
 * それ以外は既存のパスワードログインを表示する。
 *
 * Entra ログイン失敗時、callback が ?error= を付けて戻す。理由は機密を含まない
 * 短い既知コードのみに正規化して表示する（生の IdP メッセージは出さない）。
 */
const ENTRA_ERROR_MESSAGE: Record<string, string> = {
  invalid_state: 'ログインセッションが無効です。もう一度サインインしてください。',
  token_exchange_failed: 'サインインを完了できませんでした。もう一度お試しください。',
  unauthorized: 'このアカウントには管理画面へのアクセス権がありません。',
  access_denied: 'サインインがキャンセルされました。',
};

function describeEntraError(raw: string | undefined): string | null {
  if (!raw) return null;
  return ENTRA_ERROR_MESSAGE[raw] ?? 'サインインに失敗しました。もう一度お試しください。';
}

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const provider = getAdminAuthConfig().provider;
  const params = (await searchParams) ?? {};
  const rawError = Array.isArray(params.error) ? params.error[0] : params.error;
  const errorMessage = describeEntraError(rawError);

  return (
    <section style={{ maxWidth: 360 }}>
      <h1 style={{ marginTop: 0 }}>管理ログイン</h1>
      {errorMessage ? (
        <p
          data-testid="admin-login-error"
          className="notice notice--danger"
          style={{ padding: 12, marginTop: 0 }}
        >
          {errorMessage}
        </p>
      ) : null}
      {provider === 'entra' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ opacity: 0.8, margin: 0 }}>組織の Microsoft アカウントでサインインしてください。</p>
          <a
            href="/api/admin/auth/entra/start"
            data-testid="admin-entra-signin"
            style={{
              minHeight: 44,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 8,
              background: 'var(--color-accent)',
              color: '#0f172a',
              fontWeight: 700,
              textDecoration: 'none',
              padding: '0 16px',
            }}
          >
            Microsoft でサインイン
          </a>
        </div>
      ) : (
        <AdminPasswordLogin />
      )}
    </section>
  );
}
