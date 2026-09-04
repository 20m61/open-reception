'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  parseSelectedTenantId,
  resolveSelectedTenant,
  resolveViewingContext,
  selectedTenantLabel,
  type NamedTenant,
} from '@/lib/platform/selected-tenant';
import { TenantSelect } from '../TenantContextView';
import { font } from '@/components/admin/ui/tokens';
import { PLATFORM_READ_TIMEOUT_MS, readTimeoutMessage } from './read-response';

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

  /** テナント一覧の取得。再試行から呼び直せるよう `useEffect` の外に置く (#968 レビュー 5 周目 MAJOR-6)。 */
  const loadTenants = useCallback(async (cancelled?: () => boolean) => {
    const aborted = () => cancelled?.() === true;
    try {
      const res = await fetch('/api/platform/tenants', {
        signal: AbortSignal.timeout(PLATFORM_READ_TIMEOUT_MS),
      });
      if (aborted()) return;
      /*
       * 🔴 **HTTP の失敗も報告する (#968 レビュー M-1)。** ここで最も起こりやすい失敗は
       * 403（developer 権限・昇格切れ）で、reject より遥かに多い。黙って `return` すると
       * 選択肢が空のまま「全テナント横断」だけが残り、**テナントが 1 つも無いのと同じ
       * 見た目**になる —— 取れなかったことを「無い」と言い換える形になる。
       */
      if (!res.ok) {
        setListError(
          res.status === 403
            ? 'テナント一覧の閲覧権限がありません。'
            : 'テナント一覧を取得できませんでした。',
        );
        return;
      }
      const body = (await res.json()) as { tenants?: unknown };
      // 形が違う 200 は「テナントが無い」ではなく「読めなかった」(#968 レビュー 5 周目 MAJOR-2)。
      if (!Array.isArray(body.tenants)) {
        setListError('テナント一覧の形式が不正です。');
        return;
      }
      setListError(null);
      setTenants(body.tenants as NamedTenant[]);
    } catch (cause) {
      if (!aborted())
        setListError(
          cause instanceof Error && cause.name === 'TimeoutError'
            ? readTimeoutMessage('テナント一覧')
            : 'テナント一覧を取得できませんでした。',
        );
    }
  }, []);

  useEffect(() => {
    setSelectedId(parseSelectedTenantId(document.cookie));
    let cancelled = false;
    void loadTenants(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadTenants]);

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
      /*
       * 🔴 **エラーは「表示中」を押しのけない (#968 レビュー M-4)。**
       *
       * 当初は優先順位つき三項で先頭に置いたが、`switchError` は次の切替まで消えないので、
       * 一度切替に失敗すると `表示中: <name>` と **`（選択中と別）`（#423 の越境警告）が
       * 恒久的に消える**。切替が成立しなかった直後は「スコープが変わったつもりで変わって
       * いない」まさにその瞬間で、そこで越境警告を消すのは方向が逆である。**併記する。**
       */
      trailing={
        <>
          {switchError !== null ? (
            <span
              role="alert"
              data-testid="platform-tenant-switch-error"
              style={{ fontSize: font.small, color: 'var(--color-platform-warn)' }}
            >
              {switchError}
            </span>
          ) : null}
          {listError !== null ? (
            <span
              role="alert"
              data-testid="platform-tenant-list-error"
              style={{ fontSize: font.small, color: 'var(--color-platform-warn)' }}
            >
              {listError}{' '}
              {/*
                🔴 **いちばん広く塞ぐところにこそ復帰導線が要る (#968 レビュー 5 周目 MAJOR-6)。**
                ここが引けないと、他画面の「画面上部の切替で選んでください」という案内の
                **指示先が死ぬ**。運用者に残るのはブラウザのリロードだけになる。
              */}
              <button
                type="button"
                data-testid="platform-tenant-list-retry"
                onClick={() => void loadTenants()}
              >
                再試行
              </button>
            </span>
          ) : null}
          {viewing.tenantName !== null ? (
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
          )}
        </>
      }
    />
  );
}
