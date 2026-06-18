import { getAdminAuthConfig } from '@/lib/auth/admin-auth-config';
import { AdminPasswordLogin } from '@/components/admin/AdminPasswordLogin';

/**
 * 管理画面ログイン (issue #24, #70)。
 * ADMIN_AUTH_PROVIDER=entra のときは Microsoft Entra ID のサインインへ誘導し、
 * それ以外は既存のパスワードログインを表示する。
 */
export default function AdminLoginPage() {
  const provider = getAdminAuthConfig().provider;

  return (
    <section style={{ maxWidth: 360 }}>
      <h1 style={{ marginTop: 0 }}>管理ログイン</h1>
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
