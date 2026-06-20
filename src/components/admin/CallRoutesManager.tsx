'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CallRoute, CallTargetGroup } from '@/lib/notification/types';

/**
 * 呼び出し先・通知ルート管理 (issue #88, increment 1)。
 *
 * テナント/サイト配下の通知ルート一覧・作成・名称編集・有効/無効・削除を管理 API 経由で行う。
 * 「どこに通知が飛ぶか」を非エンジニアでも把握できるよう、ルートごとに
 * グループ → 呼び出し先（チャネル + 優先順）を順序つきで可視化する（issue #88 UI 方針）。
 * 削除は本番運用に影響するため確認ダイアログを挟む。
 *
 * inc1 のスコープ:
 *   - 呼び出し先（グループ/ターゲット）の作成 UI はシードと API で表現し、画面からは
 *     名称・有効状態の編集と削除に絞る。グループ/ターゲットの編集フォームは次増分。
 *   - actor 解決は中央モジュールに委譲。tenant 切り替え UI は次増分（単一テナント互換）。
 *
 * 電話番号・メール等の通知先 value は機微情報のため一覧では伏せ字表示する。
 */
const DEFAULT_TENANT_ID = 'internal';
const DEFAULT_SITE_ID = 'default-site';

const CHANNEL_LABELS: Record<string, string> = {
  phone: '電話',
  email: 'メール',
  slack: 'Slack',
  teams: 'Teams',
  webpush: 'Web Push',
};

/** 通知先の機微値を伏せる（末尾数桁のみ残す）。 */
function maskValue(value: string): string {
  if (value.length <= 4) return '****';
  return `****${value.slice(-4)}`;
}

export function CallRoutesManager({
  tenantId = DEFAULT_TENANT_ID,
  siteId = DEFAULT_SITE_ID,
}: {
  tenantId?: string;
  siteId?: string;
}) {
  const [items, setItems] = useState<CallRoute[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/admin/call-routes?tenantId=${encodeURIComponent(tenantId)}&siteId=${encodeURIComponent(siteId)}`,
    );
    if (res.ok) setItems((await res.json()) as CallRoute[]);
  }, [tenantId, siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = useCallback(async () => {
    if (name.trim() === '' || busy) return;
    setBusy(true);
    try {
      await fetch('/api/admin/call-routes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId, siteId, name }),
      });
      setName('');
      await load();
    } finally {
      setBusy(false);
    }
  }, [name, busy, tenantId, siteId, load]);

  const patch = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      await fetch(`/api/admin/call-routes/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId, ...body }),
      });
      await load();
    },
    [tenantId, load],
  );

  const toggle = useCallback(
    (r: CallRoute) => patch(r.id, { enabled: !r.enabled }),
    [patch],
  );

  const saveName = useCallback(
    async (id: string) => {
      if (editName.trim() === '') return;
      await patch(id, { name: editName });
      setEditingId(null);
      setEditName('');
    },
    [editName, patch],
  );

  const remove = useCallback(
    async (r: CallRoute) => {
      // 本番運用に影響するため確認ダイアログを挟む（issue #88 UI 方針）。
      if (!window.confirm(`通知ルート「${r.name}」を削除します。よろしいですか?`)) return;
      await fetch(`/api/admin/call-routes/${r.id}?tenantId=${encodeURIComponent(tenantId)}`, {
        method: 'DELETE',
      });
      await load();
    },
    [tenantId, load],
  );

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>呼び出しルート</h1>
      <p style={{ opacity: 0.7, marginTop: -8 }}>
        テナント <code>{tenantId}</code> / 拠点 <code>{siteId}</code> の受付通知ルートを管理します。
        ルートごとに「どのグループの誰へ、どの手段で、どの順番で通知するか」を確認できます。
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 24 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: '0.85rem', opacity: 0.8 }}>ルート名</span>
          <input
            data-testid="route-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={inputStyle}
          />
        </label>
        <button
          type="button"
          data-testid="route-add"
          onClick={add}
          disabled={busy || name.trim() === ''}
          style={btnStyle}
        >
          追加
        </button>
      </div>

      <div data-testid="route-list" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {items.map((r) => (
          <article
            key={r.id}
            data-testid="route-card"
            style={{
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 12,
              padding: 16,
              background: 'var(--color-surface)',
            }}
          >
            <header style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              {editingId === r.id ? (
                <input
                  data-testid="route-edit-input"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  style={inputStyle}
                />
              ) : (
                <strong data-testid="route-name" style={{ fontSize: '1.05rem' }}>
                  {r.name}
                </strong>
              )}
              <span
                data-testid="route-status"
                style={{
                  fontSize: '0.8rem',
                  color: r.enabled ? 'var(--color-success)' : 'var(--color-muted)',
                }}
              >
                {r.enabled ? '有効' : '無効'}
              </span>
              <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                {editingId === r.id ? (
                  <>
                    <button type="button" data-testid="route-save" onClick={() => saveName(r.id)} style={smallBtn}>
                      保存
                    </button>
                    <button type="button" onClick={() => setEditingId(null)} style={smallBtn}>
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      data-testid="route-edit"
                      onClick={() => {
                        setEditingId(r.id);
                        setEditName(r.name);
                      }}
                      style={smallBtn}
                    >
                      名称編集
                    </button>
                    <button type="button" data-testid="route-toggle" onClick={() => toggle(r)} style={smallBtn}>
                      {r.enabled ? '無効化' : '有効化'}
                    </button>
                    <button type="button" data-testid="route-delete" onClick={() => remove(r)} style={dangerBtn}>
                      削除
                    </button>
                  </>
                )}
              </div>
            </header>

            <RouteFlow groups={r.groups} />
          </article>
        ))}
      </div>
    </section>
  );
}

/** ルートの通知順序を可視化する（グループ → 呼び出し先 を順序つきで表示）。 */
function RouteFlow({ groups }: { groups: CallTargetGroup[] }) {
  if (groups.length === 0) {
    return (
      <p data-testid="route-empty" style={{ opacity: 0.6, fontSize: '0.85rem', marginBottom: 0 }}>
        呼び出し先が未設定です。
      </p>
    );
  }
  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {groups.map((g, gi) => (
        <div key={`${g.label}-${gi}`} data-testid="route-group">
          <div style={{ fontSize: '0.8rem', opacity: 0.7, marginBottom: 4 }}>
            グループ {gi + 1}: {g.label}
          </div>
          <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {[...g.targets]
              .sort((a, b) => a.priority - b.priority)
              .map((t, ti) => (
                <li key={`${t.label}-${ti}`} data-testid="route-target" style={{ fontSize: '0.9rem' }}>
                  <span>{t.label}</span>{' '}
                  <span style={{ opacity: 0.7 }}>
                    （{CHANNEL_LABELS[t.channel] ?? t.channel} / {maskValue(t.value)}）
                  </span>
                </li>
              ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  minHeight: 44,
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--color-surface-2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
};
const btnStyle: React.CSSProperties = {
  minHeight: 44,
  padding: '8px 16px',
  borderRadius: 8,
  border: 'none',
  background: 'var(--color-accent)',
  color: '#0f172a',
  fontWeight: 700,
  cursor: 'pointer',
};
const smallBtn: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  cursor: 'pointer',
};
const dangerBtn: React.CSSProperties = {
  ...smallBtn,
  borderColor: 'rgba(248,113,113,0.5)',
  color: 'var(--color-danger, #f87171)',
};
