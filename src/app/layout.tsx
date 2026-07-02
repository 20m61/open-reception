import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

// 専用書体（Latin）。next/font が self-host するため CSP（font-src 'self'）と整合し、
// 外部リクエスト・FOUT なし。日本語/韓国語/中国語のグリフは system スタックへフォールバックする。
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

/**
 * nonce ベース CSP（issue #200）のため全ルートを動的レンダリングに固定する。
 * nonce は per-request で、Next.js がリクエストヘッダの CSP から抽出して
 * inline/bootstrap script へ付与するのは SSR 時のみ。静的プリレンダリング
 * （従来は / と /kiosk 系のみ）だと build 時の HTML に nonce が無く、
 * per-request CSP と不一致になり全スクリプトがブロックされる（#200 撤回の根因）。
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'open-reception',
  description: 'iPad 受付端末向け無人受付システム',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // 拡大縮小は無効化しない（WCAG 1.4.4 Resize text）。ロービジョンの来訪者が
  // ピンチズームで読めるようにする。キオスク運用での操作制限は MDM/ガイドアクセス側で行う。
  themeColor: '#0f172a',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
