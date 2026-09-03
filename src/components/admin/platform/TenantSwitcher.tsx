'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  parseSelectedTenantId,
  resolveSelectedTenant,
  resolveViewingContext,
  selectedTenantLabel,
  type NamedTenant,
} from '@/lib/platform/selected-tenant';
import { TenantSelect } from '../TenantContextView';
import { font } from '@/components/admin/ui/tokens';

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
  /**
   * **pathname は必ずクライアントから取る (#423)。**
   *
   * 第 85 wave では server layout が `x-or-pathname` ヘッダから読んで prop で渡していたが、
   * 一覧 → 詳細は `next/link` のクライアント遷移で、**共有 layout は再レンダリングされない**
   * （App Router はセグメントを跨がない layout を保持する）。そのため prop は一覧の pathname の
   * まま固まり、「表示中」はハードロード時しか出なかった。`usePathname` は遷移で更新される。
   *
   * この欠陥は e2e が **skip されていた**ため 1 周気づかれなかった（unit は純関数側だけを見ており、
   * 純関数は正しかった）。詳細は tests/e2e/platform-viewing-context.spec.ts。
   */
  const pathname = usePathname() ?? '';
  const [tenants, setTenants] = useState<NamedTenant[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /*
   * 一覧が取れなかったことを言う (#968)。取れないと選択肢が空のまま「全テナント横断」
   * だけが残り、**テナントが 1 つも無いのと同じ見た目**になる。切替の入口なので、
   * 「選べない」を黙って「選ぶものが無い」に化けさせない。
   */
  const [listError, setListError] = useState<string | null>(null);
  /*
   * 切替そのものが成立しなかったこと (#968 レビュー M5)。**選択表示を戻すだけでは無言**で、
   * 運用者から見えるのは「プルダウンが勝手に戻る」挙動だけになる。切替は監査に残す操作
   * （#83 §5）で、失敗すると読み取りスコープが変わったつもりで変わっていない状態になる。
   * 読み取りの失敗（`listError`）とは別に持つ —— 操作の失敗を読み取りへ載せない。
   */
  const [switchError, setSwitchError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedId(parseSelectedTenantId(document.cookie));
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/platform/tenants');
        if (cancelled || !res.ok) return;
        const body = (await res.json()) as TenantsResponse;
        if (!cancelled) setTenants(body.tenants ?? []);
      } catch {
        if (!cancelled) setListError('テナント一覧を取得できませんでした。');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = resolveSelectedTenant(tenants, selectedId);
  // URL がテナントを名指ししている画面では「表示中」を明示する (#423)。
  // select は sticky（選択中）を示し続ける — 変えると「このプルダウンを変えたら何が起きるか」が
  // 嘘になるため。**route が sticky を書き換えない**（暗黙の切り替わりを作らない）。
  const viewing = resolveViewingContext({ pathname, stickyTenantId: selectedId, tenants });

  async function onSelect(nextId: string | null): Promise<void> {
    const prevId = selectedId;
    setSelectedId(nextId);
    setSwitchError(null);
    // 切替はサーバ API に通して監査へ残す（#83 §5）。Cookie はサーバが Set-Cookie する。
    try {
      const res = await fetch('/api/platform/selected-tenant', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId: nextId }),
      });
      if (!res.ok) {
        // 切替が成立しなかった（監査に残らない切替を見かけ上も作らない）。選択表示を戻す。
        setSelectedId(prevId);
        setSwitchError('テナントを切り替えられませんでした。');
        return;
      }
    } catch {
      setSelectedId(prevId);
      setSwitchError('テナントを切り替えられませんでした。通信を確認してください。');
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
        switchError !== null ? (
          <span
            role="alert"
            data-testid="platform-tenant-switch-error"
            style={{ fontSize: font.small, color: 'var(--color-platform-warn)' }}
          >
            {switchError}
          </span>
        ) : listError !== null ? (
          <span
            role="alert"
            data-testid="platform-tenant-list-error"
            style={{ fontSize: font.small, color: 'var(--color-platform-warn)' }}
          >
            {listError}
          </span>
        ) : viewing.tenantName !== null ? (
          <span
            data-testid="platform-viewing-tenant"
            style={{ fontSize: '0.8125rem', opacity: 0.9 }}
          >
            表示中: <strong>{viewing.tenantName}</strong>
            {viewing.differsFromSticky ? (
              <span data-testid="platform-viewing-differs" style={{ opacity: 0.7 }}>
                （選択中と別）
              </span>
            ) : null}
          </span>
        ) : selected ? (
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
