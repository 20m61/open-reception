import Link from 'next/link';

/**
 * 管理画面レイアウト。
 * 管理画面は認証・認可必須 (issue #22, #24)。
 * 認証ガードは後続 issue で middleware / server-only 処理と接続する。
 */
const NAV_ITEMS = [
  { href: '/admin', label: 'ダッシュボード' },
  { href: '/admin/receptions', label: '受付履歴' },
  { href: '/admin/departments', label: '部署' },
  { href: '/admin/staff', label: '担当者' },
  { href: '/admin/assets', label: 'アセット' },
  { href: '/admin/voice', label: '音声' },
  { href: '/admin/security', label: 'セキュリティ' },
];

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div data-area="admin" style={{ display: 'flex', minHeight: '100vh' }}>
      <aside
        style={{
          width: 240,
          background: 'var(--color-surface)',
          padding: 'var(--space-lg)',
          borderRight: '1px solid rgba(255,255,255,0.1)',
        }}
      >
        <h2 style={{ fontSize: '1.25rem', marginTop: 0 }}>管理画面</h2>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {NAV_ITEMS.map((item) => (
            <Link key={item.href} href={item.href} style={{ padding: '8px 0', opacity: 0.9 }}>
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <main style={{ flex: 1, padding: 'var(--space-lg)' }}>{children}</main>
    </div>
  );
}
