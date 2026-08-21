'use client';

/**
 * 予期しない例外のときに来訪者へ見せる画面 (#736 Gate A / #629 と同じ方針)。
 *
 * ## なぜ要るのか
 *
 * `src/app` にエラー境界が**一つも無かった**（`error.tsx` / `global-error.tsx` / React の
 * `componentDidCatch` とも 0 件）。`KioskFlow` の中で未捕捉例外が 1 つでも起きると、
 * iPad には Next 既定の **"Application error: a client-side exception has occurred"** が
 * 英語で出る。
 *
 * 「劣化しても止めない」設計（音声・カメラ・アバターが全滅してもタッチで完走できる）が、
 * **React のレンダー例外という単一障害点で無効化されていた**。
 *
 * ## 何を出さないか
 *
 * 🔴 **例外の内容（message / stack / digest）を画面へ出さない。** 来訪者には読めないし、
 * 内部の構造が漏れる。`service-hold-page.ts` が origin-verify の 403 で取ったのと同じ方針。
 *
 * ## 言語判定をしない
 *
 * 例外が起きた文脈では locale の状態も信用できない（それ自体が壊れているかもしれない）。
 * 4 言語を並べる ── 読める言語が 1 つあれば伝わる。
 */
import { makeT, type Locale } from '@/lib/i18n';

/** 並べる言語。判定をしない理由は上記。 */
const LANGS: readonly Locale[] = ['ja', 'en', 'ko', 'zh'];

export function UnexpectedErrorScreen({ onRetry }: { onRetry?: () => void }) {
  return (
    <main
      data-testid="kiosk-unexpected-error"
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
      {LANGS.map((lang) => {
        const tr = makeT(lang);
        return (
          <section key={lang} lang={lang} style={{ maxWidth: 560 }}>
            <h1 style={{ fontSize: 'clamp(1.4rem, 4vw, 1.9rem)', margin: 0, lineHeight: 1.3 }}>
              {tr('kiosk.unexpectedError.title')}
            </h1>
            <p style={{ opacity: 0.82, margin: 'var(--space-sm) 0 0', lineHeight: 1.7 }}>
              {tr('kiosk.unexpectedError.lead')}
            </p>
          </section>
        );
      })}

      {onRetry ? (
        <button
          type="button"
          className="btn btn--primary"
          data-testid="kiosk-unexpected-error-retry"
          onClick={onRetry}
          style={{ minHeight: 'var(--touch-target-min)', minWidth: 240 }}
        >
          {makeT('ja')('kiosk.unexpectedError.retry')}
        </button>
      ) : null}
    </main>
  );
}
