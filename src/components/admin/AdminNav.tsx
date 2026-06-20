'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { TenantRole } from '@/domain/tenant/types';
import { type NavGroup, isActivePath, visibleNav } from './navigation';

/**
 * 責務グループ表示・現在地表示・ロールに応じた出し分けを担うナビ (issue #85)。
 * 表示制御のみ。認可は API 側で検証する。admin / platform 両シェルで共用する。
 */
export function AdminNav({
  nav,
  roles,
}: {
  /** 表示する IA（ADMIN_NAV / PLATFORM_NAV）。 */
  nav: readonly NavGroup[];
  /** 現在の actor が持つロール集合（表示出し分けに使用）。 */
  roles: readonly TenantRole[];
}) {
  const pathname = usePathname() ?? '';
  const groups = visibleNav(nav, roles);

  return (
    <nav aria-label="管理ナビゲーション" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
            {group.items.map((item) => {
              const active = isActivePath(item.href, pathname);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  data-active={active ? 'true' : undefined}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 8,
                    textDecoration: 'none',
                    color: 'var(--color-text)',
                    opacity: active ? 1 : 0.8,
                    background: active ? 'var(--color-surface-2)' : 'transparent',
                    fontWeight: active ? 700 : 400,
                    borderLeft: active ? '3px solid var(--color-accent)' : '3px solid transparent',
                  }}
                >
                  {item.label}
                  {item.danger ? (
                    <span
                      aria-label="危険操作を含む"
                      title="危険操作を含む"
                      style={{ marginLeft: 6, color: '#f87171' }}
                    >
                      ⚠
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
