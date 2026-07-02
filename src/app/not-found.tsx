import Link from 'next/link';

/**
 * カスタム 404（issue #289）。
 *
 * Next.js 既定の not-found はインライン `<style>` 要素を含み、CSP の
 * style-src 'self'（'unsafe-inline' 排除）でブロックされて無スタイル表示になる。
 * style 属性（style-src-attr で許可）のみで組んだ自前ページに置き換える。
 * トーンはランディング（src/app/page.tsx）に合わせる。
 */
export default function NotFound() {
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
        wordBreak: 'keep-all',
        overflowWrap: 'anywhere',
      }}
    >
      <div style={{ display: 'grid', gap: 'var(--space-sm)', maxWidth: 560 }}>
        <p style={{ letterSpacing: '0.18em', fontSize: '0.8rem', opacity: 0.6, margin: 0 }}>404</p>
        <h1 style={{ fontSize: 'clamp(2rem, 5vw, 2.8rem)', margin: 0, lineHeight: 1.15 }}>
          ページが見つかりません
        </h1>
        <p style={{ opacity: 0.82, margin: 0, fontSize: '1.05rem' }}>
          URL が正しいかご確認ください。受付端末は管理画面で発行する受付URL／QR から開いてください。
        </p>
      </div>
      <Link
        href="/"
        style={{
          minHeight: 'var(--touch-target-min)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--color-accent)',
          color: '#0f172a',
          borderRadius: 'var(--radius-lg)',
          fontWeight: 700,
          padding: '0 28px',
        }}
      >
        トップへ戻る
      </Link>
    </main>
  );
}
