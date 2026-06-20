import type { ReactNode } from 'react';
import type { TenantRole } from '@/domain/tenant/types';
import type { NavGroup } from './navigation';
import { AdminNav } from './AdminNav';

/**
 * 管理エリア共通シェル (issue #85, increment 1)。
 * サイドバー（責務グループ別ナビ）+ ヘッダ（タイトル・対象テナント明示）+ 本文。
 * admin / platform 双方で再利用する。既存ページの中身には触れない（非破壊）。
 */
export function AdminShell({
  area,
  title,
  nav,
  roles,
  /** developer/platform でテナント横断する場合の対象テナント表示（#85 安全 UX）。 */
  tenantLabel,
  children,
}: {
  area: 'admin' | 'platform';
  title: string;
  nav: readonly NavGroup[];
  roles: readonly TenantRole[];
  tenantLabel?: string;
  children: ReactNode;
}) {
  return (
    <div data-area={area} style={{ display: 'flex', minHeight: '100vh' }}>
      <aside
        style={{
          width: 240,
          flexShrink: 0,
          background: 'var(--color-surface)',
          padding: 'var(--space-lg)',
          borderRight: '1px solid rgba(255,255,255,0.1)',
        }}
      >
        <h2 style={{ fontSize: '1.25rem', marginTop: 0, marginBottom: 'var(--space-md)' }}>
          {title}
        </h2>
        <AdminNav nav={nav} roles={roles} />
      </aside>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: 'var(--space-md) var(--space-lg)',
            borderBottom: '1px solid rgba(255,255,255,0.1)',
          }}
        >
          <span style={{ opacity: 0.6, fontSize: '0.875rem' }}>
            {area === 'platform' ? 'プラットフォーム運用' : 'テナント管理'}
          </span>
          {tenantLabel ? (
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
        <main style={{ flex: 1, padding: 'var(--space-lg)' }}>{children}</main>
      </div>
    </div>
  );
}
