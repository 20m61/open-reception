# 管理画面 SPA ライク化 設計 (issue #94)

管理画面（`/admin/*` `/platform/*`）を Next.js App Router の良さ（nested layout / RSC /
ルーティング）を保ったまま、操作感だけ SPA に寄せる方針と、その適用範囲・次増分を定義する。

関連: #85（フロント基盤・IA）, #92（デザイン方針・UI プリミティブ）, #80（マルチテナント）。

## 1. 基本方針

- **Next.js のルーティングを正とし、操作感だけ SPA に寄せる。** SPA フレームワークへは
  寄せ替えない。nested layout（共通シェル）は遷移で再マウントしない。
- **共通シェル（サイドバー/ヘッダ）は持続させ、本文だけを差し替える。** ルート遷移時の
  「読み込み中」は画面全体ではなく本文領域（領域単位）に出す。
- **見た目は CSS、状態だけ JS。** 開閉・レスポンシブ・アニメーションは `globals.css` に
  集約し、React 側は最小の状態（サイドバー開閉）だけを持つ。
- **非破壊。** 既存ページ・ルート・認可・レイアウトガード（#117 / #80）は変更しない。

## 2. increment 1 の適用範囲（本 PR）

| 観点                     | 実装                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------- |
| クライアント遷移         | `AdminNav` の `Link` を **prefetch 有効**化（隣接画面を先読み）                          |
| 遷移中フィードバック     | `useLinkStatus`（Next 16）で「遷移中の項目」にスピナー（全リロードなしの可視化）        |
| 領域単位ローディング     | `app/admin/loading.tsx` / `app/platform/loading.tsx` が本文だけスケルトン化            |
| アクティブ表示の即時反映 | `usePathname` ベースの判定（クライアント遷移で即時更新。判定は `isActivePath`）         |
| iPad/モバイル サイドバー | `AdminShell` をクライアント化しドロワー開閉（ハンバーガー / 背景タップ / Esc で閉じる） |
| シェル持続               | 共通シェルはレイアウト直下に保持。遷移で再マウントしない                                |
| A11y / モーション        | `aria-current` / `aria-expanded` / `role="status"`、`prefers-reduced-motion` を尊重    |

### 触ったファイル

- `src/components/admin/AdminShell.tsx` … クライアント化 + レスポンシブ ドロワー骨組み。
- `src/components/admin/AdminNav.tsx` … prefetch + `useLinkStatus` 遷移中表示 + `onNavigate`。
- `src/components/admin/nav-link-style.ts`（新規）… active/aria の純関数（テスト可能化）。
- `src/components/admin/ui/Skeleton.tsx`（新規）… `Skeleton` / `SkeletonBlock`（#92 ui 配下）。
- `src/components/admin/ui/index.ts` … Skeleton を barrel に追加。
- `src/app/admin/loading.tsx` / `src/app/platform/loading.tsx`（新規）… 本文スケルトン。
- `src/app/globals.css` … `.admin-shell*` レスポンシブ + アニメーション（reduced-motion 対応）。

## 3. 非破壊の根拠

- `navigation.ts`（IA データ）は **参照のみ**。`route-guard` / `lib/auth` / `proxy.ts` /
  `checkin` / `kiosk` / 監査ログ系には触れていない。
- `AdminShell` の公開 props（`area` / `title` / `nav` / `roles` / `tenantLabel` /
  `tenantSwitcher` / `children`）は不変。`layout.tsx`（admin / platform）の呼び出しは無改修。
- 既存テスト（`navigation.test.ts` / `route-guard.test.ts`）は不変で緑のまま。
- `children` と `tenantSwitcher` は引き続きサーバ側で描画され、シェルのクライアント化は
  RSC ツリーを壊さない（client component は server children を props で受け取れる）。

## 4. 次増分（increment 2 以降）

- URL を状態の正にする（検索 / フィルタ / ソート / ページ / タブ / 選択中 Tenant）。
  `nuqs` 等の採否を #105 ライセンスチェック込みで判断し、代表画面（`/admin/sites` 等）で適用。
- server state 管理（TanStack Query 等）の導入方針と global state の最小化。
- 一覧 / 詳細 / 編集 / 履歴の master-detail 標準画面パターンと、empty / error /
  permission-denied 表示の統一（#92 ui プリミティブへ寄せる）。
- ルート遷移のトップ プログレスバー（任意）と、スケルトンの画面別最適化。
