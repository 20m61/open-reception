import Link from 'next/link';

/**
 * ランディングページ (docs/reception-issuance-design.md §2)。
 *
 * 主導線は「ログイン」→ 管理画面。受付端末（/kiosk）は公開導線に出さない（直リンクを置かない）。
 * 受付端末の想定プロビジョニングは管理画面発行の受付URL/QR からのエンロール。
 * 注: `/kiosk` への直接到達自体のアクセス制御は #23（PIN/IP allowlist）が担う。`/kiosk` を
 * kiosk セッション必須にする完全なゲートは後続（docs/reception-issuance-design.md §6）。
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
        wordBreak: 'keep-all',
        overflowWrap: 'anywhere',
      }}
    >
      <div style={{ display: 'grid', gap: 'var(--space-sm)', maxWidth: 620 }}>
        <p style={{ letterSpacing: '0.18em', fontSize: '0.8rem', opacity: 0.6, margin: 0 }}>
          UNMANNED RECEPTION
        </p>
        <h1 style={{ fontSize: 'clamp(2.4rem, 6vw, 3.4rem)', margin: 0, lineHeight: 1.1 }}>
          open-reception
        </h1>
        {/*
          タグラインの不自然な折返し対策 (#326 L1)。親 <main> の wordBreak:'keep-all' は
          CJK の語中改行こそ避けるが、区切り（スペース）の無い長い和文の連なりを
          「1 つの分割不能な語」として扱ってしまい、結局 overflowWrap:'anywhere' の
          最終手段が任意の位置で発火して不自然な折返しになっていた。この段落だけ通常の
          禁則処理（wordBreak:'normal'）に戻し、文の切れ目で明示的に改行してキャッチコピー
          と説明文を視覚的に分ける。
        */}
        <p
          style={{
            opacity: 0.82,
            margin: 0,
            fontSize: '1.05rem',
            lineHeight: 1.7,
            wordBreak: 'normal',
          }}
        >
          来訪体験を、会社の顔に。
          <br />
          iPad 受付端末向けの無人受付システム。管理画面から受付端末を発行・運用します。
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
