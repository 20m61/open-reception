import Link from 'next/link';

/**
 * ルートはエントリの分岐のみを担う。
 * 受付端末は /kiosk、運用管理は /admin に分離する (issue #9, #24)。
 */
export default function HomePage() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-lg)',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-lg)',
      }}
    >
      <h1 style={{ fontSize: '2.5rem', margin: 0 }}>open-reception</h1>
      <p style={{ opacity: 0.8, textAlign: 'center', maxWidth: 480 }}>
        iPad 受付端末向け無人受付システム。受付端末と運用管理は入口を分離しています。
      </p>
      <nav style={{ display: 'flex', gap: 'var(--space-lg)', flexWrap: 'wrap', justifyContent: 'center' }}>
        <Link
          href="/kiosk"
          style={{
            minWidth: 220,
            minHeight: 'var(--touch-target-min)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--color-accent)',
            color: '#0f172a',
            borderRadius: 'var(--radius-lg)',
            fontWeight: 700,
            fontSize: '1.25rem',
          }}
        >
          受付端末 (/kiosk)
        </Link>
        <Link
          href="/admin"
          style={{
            minWidth: 220,
            minHeight: 'var(--touch-target-min)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--color-surface)',
            color: 'var(--color-text)',
            borderRadius: 'var(--radius-lg)',
            fontWeight: 700,
            fontSize: '1.25rem',
            border: '1px solid rgba(255,255,255,0.15)',
          }}
        >
          管理画面 (/admin)
        </Link>
      </nav>
    </main>
  );
}
