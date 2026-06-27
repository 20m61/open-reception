import Link from 'next/link';

/**
 * ランディングページ (docs/reception-issuance-design.md §2)。
 *
 * 主導線は「ログイン」→ 管理画面。受付端末（/kiosk）は公開導線から到達させず、
 * 管理画面が発行した受付URL/QR からのみ有効化する方針のため、ここに直リンクは置かない。
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
        textAlign: 'center',
      }}
    >
      <div style={{ display: 'grid', gap: 'var(--space-sm)', maxWidth: 560 }}>
        <p style={{ letterSpacing: '0.18em', fontSize: '0.8rem', opacity: 0.6, margin: 0 }}>
          UNMANNED RECEPTION
        </p>
        <h1 style={{ fontSize: 'clamp(2.4rem, 6vw, 3.4rem)', margin: 0, lineHeight: 1.1 }}>
          open-reception
        </h1>
        <p style={{ opacity: 0.82, margin: 0, fontSize: '1.05rem' }}>
          来訪体験を、会社の顔に。iPad 受付端末向けの無人受付システム。
          管理画面から受付端末を発行・運用します。
        </p>
      </div>

      <nav style={{ display: 'flex', gap: 'var(--space-md)', flexWrap: 'wrap', justifyContent: 'center' }}>
        <Link
          href="/admin/login"
          data-testid="lp-login"
          style={{
            minWidth: 240,
            minHeight: 'var(--touch-target-min)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--color-accent)',
            color: '#0f172a',
            borderRadius: 'var(--radius-lg)',
            fontWeight: 700,
            fontSize: '1.2rem',
            padding: '0 28px',
          }}
        >
          ログイン
        </Link>
      </nav>

      <p style={{ fontSize: '0.85rem', opacity: 0.55, margin: 0, maxWidth: 420 }}>
        受付端末は管理画面で発行する受付URL／QR から開いてください。
      </p>
    </main>
  );
}
