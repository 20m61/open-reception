'use client';

import { useEffect, useState } from 'react';
import {
  parseSelectedTenantId,
  resolveSelectedTenant,
  selectedTenantLabel,
  type NamedTenant,
} from '@/lib/platform/selected-tenant';
import { TenantSelect } from '../TenantContextView';

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
 *
 * **admin 側の切替とは意味が違うので一本化しない**（母集合・未選択の有無・永続化と監査・
 * 反映方法がすべて別。対比表は `TenantContextView` に置いた）。共有するのは表示だけ。
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

  async function onSelect(nextId: string | null): Promise<void> {
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
    <TenantSelect
      // admin 側と別の testid にする（統合前は両方 `tenant-switcher` だった・#423）。
      testId="platform-tenant-switcher"
      options={tenants}
      value={selectedId}
      // platform だけが持つ「未選択＝全テナント横断」。admin には出さない。
      nullOptionLabel="全テナント横断"
      onSelect={(next) => void onSelect(next)}
      trailing={
        selected ? (
          <a
            href={`/platform/tenants/${selected.id}`}
            style={{ fontSize: '0.8125rem', opacity: 0.8 }}
            data-testid="tenant-switcher-detail-link"
          >
            詳細
          </a>
        ) : (
          <span style={{ fontSize: '0.8125rem', opacity: 0.5 }}>{selectedTenantLabel(null)}</span>
        )
      }
    />
  );
}
