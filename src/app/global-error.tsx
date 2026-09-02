'use client';

/**
 * ルートレイアウトまで壊れたときの最後の砦 (#736 Gate A)。
 *
 * `error.tsx` は自分のセグメントより下の例外しか拾えない。**レイアウト自身が落ちると
 * 通らない**ので、その場合はここが受ける（Next の契約上、`<html>` / `<body>` を自分で描く）。
 *
 * 🔴 **外部リソースを一切参照しない。** ここへ来る時点で CSS もフォントも読めていない
 * 可能性がある。`service-hold-page.ts` が origin-verify の 403 で自己完結 HTML にしたのと
 * 同じ理由 ── 壊れているときに追加の読み込みを当てにしない。
 *
 * 🔴 **例外の内容を出さない**（`error.tsx` と同じ）。
 */
import { useEffect } from 'react';
import { unexpectedErrorLogLine } from '@/lib/observability/unexpected-error-log';

const MESSAGES: readonly { readonly lang: string; readonly title: string; readonly body: string }[] = [
  {
    lang: 'ja',
    title: '受付を続けられませんでした',
    body: '恐れ入りますが、近くのスタッフにお声がけください。',
  },
  {
    lang: 'en',
    title: 'We could not continue with check-in',
    body: 'Please ask a nearby staff member for assistance.',
  },
  {
    lang: 'ko',
    title: '접수를 계속할 수 없었습니다',
    body: '가까운 직원에게 말씀해 주세요.',
  },
  { lang: 'zh', title: '无法继续办理登记', body: '请向附近的工作人员咨询。' },
];

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    console.error(JSON.stringify(unexpectedErrorLogLine('app', error)));
  }, [error]);

  return (
    <html lang="ja">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          textAlign: 'center',
          fontFamily: 'system-ui, sans-serif',
          background: '#0f172a',
          color: '#f8fafc',
        }}
      >
        {MESSAGES.map((m) => (
          <section key={m.lang} lang={m.lang} style={{ maxWidth: 560 }}>
            <h1 style={{ fontSize: '1.5rem', margin: 0, lineHeight: 1.3 }}>{m.title}</h1>
            <p style={{ opacity: 0.82, margin: '8px 0 0', lineHeight: 1.7 }}>{m.body}</p>
          </section>
        ))}
      </body>
    </html>
  );
}
