'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  IntegrationStatus,
  SecretKey,
  SecretStatus,
} from '@/domain/security/integration-status';
import { SecretStatusField } from './SecretStatusField';

/**
 * 認証方式・外部連携・シークレット状態の管理 (issue #93, increment 1)。
 *
 * 既存 /admin/security（受付端末アクセス制御）は書き換えず、本画面が認証/連携/secret
 * 状態の新エリアを担う（関係は docs/auth-integration-secret-ui-design.md）。
 *
 * セキュリティ最優先: API は secret/private key の値を返さない。本コンポーネントも
 * 値を保持・送信しない。表示・操作するのは状態（設定済み/未設定/最終更新/接続結果）のみ。
 *
 * inc1 は単一テナント運用の互換シード `internal` を既定テナントとして扱う。
 */
const DEFAULT_TENANT_ID = 'internal';

type AuthMethod = { id: string; label: string; enabled: boolean; issues: string[] };
type StatusView = {
  authMethods: AuthMethod[];
  integrations: IntegrationStatus[];
  secrets: SecretStatus[];
};

export function IntegrationsManager({
  tenantId = DEFAULT_TENANT_ID,
  /** 書込操作（接続テスト・secret 状態変更）を見せるか。実認可は API 側が最終判定。 */
  canManage = true,
}: {
  tenantId?: string;
  canManage?: boolean;
}) {
  const [view, setView] = useState<StatusView | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState<SecretKey | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/integrations?tenantId=${encodeURIComponent(tenantId)}`);
    if (res.ok) setView((await res.json()) as StatusView);
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const runTest = useCallback(
    async (id: string) => {
      if (busy) return;
      setBusy(true);
      try {
        await fetch('/api/admin/integrations/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tenantId, id }),
        });
        await load();
      } finally {
        setBusy(false);
      }
    },
    [busy, tenantId, load],
  );

  const markSecret = useCallback(
    async (key: SecretKey) => {
      if (busy) return;
      setBusy(true);
      try {
        await fetch('/api/admin/integrations/secrets', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tenantId, key }),
        });
        await load();
      } finally {
        setBusy(false);
      }
    },
    [busy, tenantId, load],
  );

  const clearSecret = useCallback(
    async (key: SecretKey) => {
      setConfirmClear(null);
      if (busy) return;
      setBusy(true);
      try {
        await fetch('/api/admin/integrations/secrets', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tenantId, key }),
        });
        await load();
      } finally {
        setBusy(false);
      }
    },
    [busy, tenantId, load],
  );

  if (!view) {
    return (
      <section>
        <h1 style={{ marginTop: 0 }}>認証・外部連携</h1>
        <p>読み込み中…</p>
      </section>
    );
  }

  return (
    <section style={{ maxWidth: 720 }}>
      <h1 style={{ marginTop: 0 }}>認証・外部連携</h1>
      <p style={{ opacity: 0.75, marginTop: -4 }}>
        ログイン方式・外部連携・シークレットの<strong>状態</strong>を確認します。
        機密値そのものはこの画面には表示されません。
      </p>

      <h2 style={{ fontSize: '1.05rem' }}>ログイン方式</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}>
        {view.authMethods.map((m) => (
          <div key={m.id} data-testid={`auth-${m.id}`} style={card}>
            <strong>{m.label}</strong>
            <span data-testid={`auth-${m.id}-state`} style={{ marginLeft: 8 }}>
              {m.enabled ? '有効' : '無効'}
            </span>
            {m.issues.length > 0 ? (
              <ul style={{ margin: '6px 0 0', color: 'var(--color-danger)' }}>
                {m.issues.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: '1.05rem' }}>外部連携</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}>
        {view.integrations.map((it) => (
          <div key={it.id} data-testid={`integration-${it.id}`} style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
              <div>
                <strong>{it.label}</strong>
                <span data-testid={`integration-${it.id}-state`} style={{ marginLeft: 8, opacity: 0.85 }}>
                  {it.configured ? (it.enabled ? '有効' : '設定済み（無効）') : '未設定'}
                </span>
                <div data-testid={`integration-${it.id}-result`} style={{ fontSize: '0.8rem', opacity: 0.7 }}>
                  接続テスト: {it.lastResult === 'untested' ? '未実施' : it.lastResult === 'success' ? '成功' : '失敗'}
                  {it.lastErrorSummary ? `（${it.lastErrorSummary}）` : ''}
                </div>
              </div>
              {canManage ? (
                <button
                  type="button"
                  data-testid={`integration-${it.id}-test`}
                  onClick={() => runTest(it.id)}
                  disabled={busy}
                  style={primary}
                >
                  接続テスト
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: '1.05rem' }}>シークレット状態</h2>
      <p style={{ fontSize: '0.8rem', opacity: 0.7, marginTop: -4 }}>
        値の登録・更新は環境変数 / Secrets Manager で行います。この画面では状態のみを管理します。
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {view.secrets.map((s) =>
          confirmClear === s.key ? (
            <div key={s.key} data-testid={`secret-${s.key}-confirm`} className="notice notice--danger" style={{ padding: 12 }}>
              <strong>{s.key}</strong> を「要更新」にしますか？（値には触れません）
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button type="button" data-testid={`secret-${s.key}-confirm-yes`} onClick={() => clearSecret(s.key)} style={danger}>
                  はい
                </button>
                <button type="button" onClick={() => setConfirmClear(null)} style={ghost}>
                  やめる
                </button>
              </div>
            </div>
          ) : (
            <SecretStatusField
              key={s.key}
              status={s}
              canManage={canManage}
              busy={busy}
              onMarkUpdated={markSecret}
              onClear={(key) => setConfirmClear(key)}
            />
          ),
        )}
      </div>
    </section>
  );
}

const card: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid var(--color-surface-2)',
  background: 'var(--color-surface)',
};
const primary: React.CSSProperties = {
  minHeight: 36,
  padding: '6px 14px',
  borderRadius: 8,
  border: 'none',
  background: 'var(--color-accent)',
  color: '#0f172a',
  fontWeight: 700,
  cursor: 'pointer',
};
const danger: React.CSSProperties = { ...primary, background: 'var(--color-danger)', color: '#fff' };
const ghost: React.CSSProperties = {
  minHeight: 36,
  padding: '6px 14px',
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  cursor: 'pointer',
};
