'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  parseSelectedTenantId,
  resolveSelectedTenant,
  selectedTenantLabel,
  SELECTED_TENANT_COOKIE,
  type NamedTenant,
} from '@/lib/platform/selected-tenant';

/**
 * 対象テナント切り替え（#83 inc3b / #90）。
 *
 * AdminShell ヘッダの `tenantSwitcher` スロットに常時表示する。対象テナントを選ぶと Cookie
 * （`or_platform_tenant`）に id を保持し、`router.refresh()` で再取得する。選択は read スコープ
 * 絞り込みの基点（各 read は Cookie の選択を参照する）。機密値・PII は持たない。
 *
 * テナント一覧は developer 専用 read API（/api/platform/tenants）から取得する。取得前は
 * 「全テナント横断」を表示する（偽の選択状態を出さない）。
 */
type TenantsResponse = { tenants: NamedTenant[] };

function writeSelectionCookie(tenantId: string): void {
  const value = tenantId ? encodeURIComponent(tenantId) : '';
  // セッション Cookie（有効期限なし）。SameSite=Lax で同一サイトのナビゲーションに付与。
  document.cookie = `${SELECTED_TENANT_COOKIE}=${value}; path=/; SameSite=Lax`;
}

export function TenantSwitcher() {
  const router = useRouter();
  const [tenants, setTenants] = useState<NamedTenant[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedId(parseSelectedTenantId(document.cookie));
    let cancelled = false;
    void (async () => {
      const res = await fetch('/api/platform/tenants');
      if (cancelled || !res.ok) return;
      const body = (await res.json()) as TenantsResponse;
      if (!cancelled) setTenants(body.tenants ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = resolveSelectedTenant(tenants, selectedId);

  function onChange(value: string): void {
    const nextId = value === '' ? null : value;
    setSelectedId(nextId);
    writeSelectionCookie(nextId ?? '');
    router.refresh();
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
      <label style={{ fontSize: '0.875rem', opacity: 0.7 }} htmlFor="platform-tenant-switcher">
        対象テナント
      </label>
      <select
        id="platform-tenant-switcher"
        data-testid="tenant-switcher"
        value={selectedId ?? ''}
        onChange={(e) => onChange(e.target.value)}
        style={{
          fontSize: '0.875rem',
          padding: '4px 10px',
          borderRadius: 999,
          background: 'var(--color-surface-2)',
          color: 'inherit',
          border: '1px solid rgba(255,255,255,0.15)',
        }}
      >
        <option value="">全テナント横断</option>
        {tenants.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      {selected ? (
        <a
          href={`/platform/tenants/${selected.id}`}
          style={{ fontSize: '0.8125rem', opacity: 0.8 }}
          data-testid="tenant-switcher-detail-link"
        >
          詳細
        </a>
      ) : (
        <span style={{ fontSize: '0.8125rem', opacity: 0.5 }}>{selectedTenantLabel(null)}</span>
      )}
    </div>
  );
}
