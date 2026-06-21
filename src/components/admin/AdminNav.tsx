'use client';

import Link, { useLinkStatus } from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import type { TenantRole } from '@/domain/tenant/types';
import { type NavGroup, type NavItem, isActivePath, visibleNav } from './navigation';
import { navLinkAriaCurrent, navLinkStyle } from './nav-link-style';

/**
 * 責務グループ表示・現在地表示・ロールに応じた出し分けを担うナビ (issue #85, SPA 化 #94)。
 * 表示制御のみ。認可は API 側で検証する。admin / platform 両シェルで共用する。
 *
 * SPA ライク化 (#94, increment 1):
 *   - `Link` の prefetch を有効化し、隣接画面への遷移を体感ゼロに近づける。
 *   - `useLinkStatus` で「遷移中の項目」にスピナーを出し、全リロードなしの遷移を可視化する。
 *   - `usePathname` 由来の active 表示はクライアント遷移で即時反映される。
 *   - 項目クリック時に `onNavigate` を呼び、モバイルのサイドバー（ドロワー）を閉じられる。
 */
export function AdminNav({
  nav,
  roles,
  onNavigate,
}: {
  /** 表示する IA（ADMIN_NAV / PLATFORM_NAV）。 */
  nav: readonly NavGroup[];
  /** 現在の actor が持つロール集合（表示出し分けに使用）。 */
  roles: readonly TenantRole[];
  /** 項目を選んだ直後に呼ばれる（モバイルのドロワーを閉じる等）。 */
  onNavigate?: () => void;
}) {
  const pathname = usePathname() ?? '';
  const groups = visibleNav(nav, roles);

  return (
    <nav
      aria-label="管理ナビゲーション"
      style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
    >
      {groups.map((group) => (
        <div key={group.id}>
          <p
            style={{
              margin: '0 0 4px',
              fontSize: '0.75rem',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              opacity: 0.55,
            }}
          >
            {group.label}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {group.items.map((item) => (
              <NavLink
                key={item.href}
                item={item}
                active={isActivePath(item.href, pathname)}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

/** 1 項目のリンク。遷移中表示（useLinkStatus）を内側で扱うため独立コンポーネント。 */
function NavLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={item.href}
      prefetch
      aria-current={navLinkAriaCurrent(active)}
      data-active={active ? 'true' : undefined}
      onClick={onNavigate}
      style={navLinkStyle(active)}
    >
      <span style={{ flex: 1 }}>{item.label}</span>
      {item.danger ? (
        <span aria-label="危険操作を含む" title="危険操作を含む" style={{ color: '#f87171' }}>
          ⚠
        </span>
      ) : null}
      <NavLinkPending />
    </Link>
  );
}

/**
 * 遷移中スピナー。`useLinkStatus` は `Link` の子孫でのみ有効。
 * pending でない間は領域を占有しない（レイアウトを揺らさない）。
 */
function NavLinkPending(): ReactNode {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <span
      role="status"
      aria-label="読み込み中"
      data-testid="nav-link-pending"
      style={{
        width: 12,
        height: 12,
        borderRadius: '50%',
        border: '2px solid currentColor',
        borderTopColor: 'transparent',
        opacity: 0.7,
        animation: 'admin-spinner-rotate 0.7s linear infinite',
      }}
    />
  );
}
