'use client';

import { useEffect, useState } from 'react';
import {
  parseSelectedTenantId,
  resolveSelectedTenant,
  selectedTenantLabel,
  type NamedTenant,
} from '@/lib/platform/selected-tenant';

/**
 * 対象テナント切り替え（#83 inc3b / #90）。
 *
 * AdminShell ヘッダの `tenantSwitcher` スロットに常時表示する。対象テナントを選ぶと
 * サーバ API（PUT /api/platform/selected-tenant）経由で Cookie（`or_platform_tenant`）に id を
 * 保持する。API を経由するのは切替を監査（platform.tenant_scope.switched, #83 §5 / inc5b）へ
 * 確実に残すため（クライアントの document.cookie 直書きではサーバから観測できない）。
 * 選択は read スコープ絞り込みの基点（各 read は Cookie の選択を参照する）。機密値・PII は持たない。
 *
 * テナント一覧は developer 専用 read API（/api/platform/tenants）から取得する。取得前は
 * 「全テナント横断」を表示する（偽の選択状態を出さない）。
 */
type TenantsResponse = { tenants: NamedTenant[] };

export function TenantSwitcher() {
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

  async function onChange(value: string): Promise<void> {
    const nextId = value === '' ? null : value;
    const prevId = selectedId;
    setSelectedId(nextId);
    // 切替はサーバ API に通して監査へ残す（#83 §5）。Cookie はサーバが Set-Cookie する。
    const res = await fetch('/api/platform/selected-tenant', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId: nextId }),
    }).catch(() => null);
    if (!res?.ok) {
      // 切替が成立しなかった（監査に残らない切替を見かけ上も作らない）。選択表示を戻す。
      setSelectedId(prevId);
      return;
    }
    // platform の各 read はクライアントで mount 時に fetch するため、router.refresh() では
    // 再取得されない。選択 Cookie を反映した read 絞り込みを全画面へ確実に効かせるため
    // フルリロードする（内部運用コンソールのため許容）。
    window.location.reload();
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
        onChange={(e) => void onChange(e.target.value)}
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
