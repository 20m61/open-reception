import type { Metadata, Viewport } from 'next';
import './globals.css';

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
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
