/**
 * 受付待機画面のプレースホルダ (issue #11 で本実装)。
 * MVP ではタッチ操作だけで受付開始できることを最優先する。
 */
export default function KioskHomePage() {
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
      <h1 style={{ fontSize: '2.75rem', margin: 0 }}>受付</h1>
      <p style={{ fontSize: '1.25rem', opacity: 0.85, maxWidth: 560 }}>
        ようこそ。画面にタッチして受付を開始してください。
      </p>
      <button
        type="button"
        style={{
          minWidth: 320,
          minHeight: 96,
          fontSize: '1.5rem',
          fontWeight: 700,
          color: '#0f172a',
          background: 'var(--color-accent)',
          border: 'none',
          borderRadius: 'var(--radius-lg)',
          cursor: 'pointer',
        }}
      >
        受付を開始する
      </button>
    </main>
  );
}
