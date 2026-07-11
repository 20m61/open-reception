import type { MetadataRoute } from 'next';

/**
 * Web App Manifest (issue #331)。
 *
 * Next.js のファイル規約により `/manifest.webmanifest` として自動配信され、
 * root layout の `<head>` に `<link rel="manifest">` が自動挿入される（手動配線不要）。
 *
 * 設計判断（issue #331 の要求事項に対応）:
 * - `display: 'standalone'` — ホーム画面追加時にブラウザ chrome を隠す。
 * - `start_url`: ホーム画面設置の主対象は iPad 受付端末（`/kiosk`）。admin/platform は
 *   実 actor 解決（#85）・SSO 前提のデスクトップ運用コンソールであり、単体 PWA として
 *   ホーム画面に置く運用は想定していないため、マニフェストは kiosk を起点にする。
 * - `scope: '/'` — マニフェストは オリジン単位で 1 つのみのため、admin/platform への
 *   遷移（テスト・デバッグ等）も standalone ウィンドウ内に留め、ブラウザへの脱出は避ける。
 * - #30（kiosk の長期セッション）との整合: start_url は固定パスの文字列であり、
 *   kiosk の端末認可（httpOnly cookie ベース）に依存するクエリパラメータ等を含まない。
 *   ホーム画面アイコンからの起動は通常のブラウザナビゲーションと同じ cookie を使うため、
 *   長期セッションの復帰動作（docs/ipad-uat.md §5, §8）に影響しない。
 * - `theme_color` / `background_color` は src/app/globals.css のデザイントークンに揃える
 *   （`--color-bg-2: #0f172a` = root layout の `viewport.themeColor` と同値、
 *   `--color-bg: #0b1120` = ページ背景のベース色）。トークン自体は編集しない（読み取りのみ）。
 * - `orientation: 'any'` — docs/ipad-uat.md は横向きを推奨しつつ縦向きの主要操作も
 *   検証対象としており、片方向へ固定しない。
 * - icons: `src/app/icon.tsx` が生成する 512x512 の単一アセットを 'any'/'maskable' の
 *   両方の purpose で参照する（アイコン自体がセーフゾーンを空けたフルブリード図柄のため
 *   両立できる。詳細は icon.tsx のコメント）。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'open-reception',
    short_name: '受付',
    description: 'iPad 受付端末向け無人受付システム',
    start_url: '/kiosk',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#0b1120',
    theme_color: '#0f172a',
    icons: [
      { src: '/icon', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
