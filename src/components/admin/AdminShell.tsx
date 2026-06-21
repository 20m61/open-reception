'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { TenantRole } from '@/domain/tenant/types';
import type { NavGroup } from './navigation';
import { AdminNav } from './AdminNav';

/**
 * 管理エリア共通シェル (issue #85; SPA 化 #94, increment 1)。
 * サイドバー（責務グループ別ナビ）+ ヘッダ（タイトル・対象テナント明示）+ 本文。
 * admin / platform 双方で再利用する。既存ページの中身には触れない（非破壊）。
 *
 * SPA ライク化 (#94, increment 1):
 *   - persistent layout（App Router の nested layout）の上で、本シェルはクライアント
 *     コンポーネントとして「サイドバーの開閉状態」だけを保持する。children は引き続き
 *     サーバ側で描画され、ルート遷移しても本シェルは再マウントされない。
 *   - iPad/モバイル幅ではサイドバーをオフキャンバスのドロワー化し、ハンバーガーで開閉。
 *     デスクトップ幅では常時表示（globals.css のメディアクエリで切替）。
 *   - ナビ項目選択時にドロワーを閉じ、クライアント遷移後にコンテンツへ集中できる。
 *
 * 補足: 開閉状態は `data-sidebar-open` で表現し、見た目は CSS に委ねる（JS は状態管理のみ）。
 */
export function AdminShell({
  area,
  title,
  nav,
  roles,
  /** developer/platform でテナント横断する場合の対象テナント表示（#85 安全 UX）。 */
  tenantLabel,
  /**
   * 対象テナント切り替え UI（#80 inc3）。指定時は tenantLabel より優先してヘッダに表示する。
   * TenantSwitcher を想定するが、AdminShell は actor 解決に依存しないよう ReactNode で受ける。
   */
  tenantSwitcher,
  children,
}: {
  area: 'admin' | 'platform';
  title: string;
  nav: readonly NavGroup[];
  roles: readonly TenantRole[];
  tenantLabel?: string;
  tenantSwitcher?: ReactNode;
  children: ReactNode;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = () => setSidebarOpen(false);

  // モバイルのドロワーを開いている間に Esc で閉じられるようにする（A11y）。
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSidebar();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sidebarOpen]);

  return (
    <div
      className="admin-shell"
      data-area={area}
      data-sidebar-open={sidebarOpen ? 'true' : 'false'}
    >
      {/* モバイルでドロワーを開いた際の背景。タップで閉じる。デスクトップでは CSS で非表示。 */}
      <button
        type="button"
        className="admin-shell__scrim"
        aria-label="メニューを閉じる"
        tabIndex={sidebarOpen ? 0 : -1}
        onClick={closeSidebar}
      />

      <aside id="admin-sidebar" className="admin-shell__sidebar" aria-label="サイドバー">
        <div className="admin-shell__sidebar-head">
          <h2 className="admin-shell__title">{title}</h2>
          <button
            type="button"
            className="admin-shell__close"
            aria-label="メニューを閉じる"
            onClick={closeSidebar}
          >
            ✕
          </button>
        </div>
        <AdminNav nav={nav} roles={roles} onNavigate={closeSidebar} />
      </aside>

      <div className="admin-shell__main-col">
        <header className="admin-shell__header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
            <button
              type="button"
              className="admin-shell__hamburger"
              aria-label="メニューを開く"
              aria-expanded={sidebarOpen}
              aria-controls="admin-sidebar"
              onClick={() => setSidebarOpen(true)}
            >
              ☰
            </button>
            <span style={{ opacity: 0.6, fontSize: '0.875rem' }}>
              {area === 'platform' ? 'プラットフォーム運用' : 'テナント管理'}
            </span>
          </div>
          {tenantSwitcher ? (
            tenantSwitcher
          ) : tenantLabel ? (
            <span
              data-testid="active-tenant"
              style={{
                fontSize: '0.875rem',
                padding: '4px 10px',
                borderRadius: 999,
                background: 'var(--color-surface-2)',
              }}
            >
              対象テナント: <strong>{tenantLabel}</strong>
            </span>
          ) : null}
        </header>
        <main className="admin-shell__content" style={{ flex: 1, padding: 'var(--space-lg)' }}>
          {children}
        </main>
      </div>
    </div>
  );
}
