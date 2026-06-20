'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SiteWithDevices } from '@/lib/tenant/site-service';

/**
 * 拠点管理 (issue #87, increment 1)。
 *
 * テナント配下の拠点一覧・作成・編集（名称）・有効/停止を管理 API 経由で行う。
 * Tenant > Site > Device の階層が分かるよう、各拠点に紐づく端末数・オンライン端末数を表示する
 * （Device の作り替えは行わず紐づけ表示に留める＝既存 kiosks 管理と二重管理しない）。
 *
 * 現状の actor 解決は developer 相当（#80 写像が未配線）。複数テナント所属時の
 * Tenant 切り替え UI は次増分（docs/site-device-management-design.md §次増分）。
 * inc1 は単一テナント運用の互換シード `internal` を既定テナントとして扱う。
 */
const DEFAULT_TENANT_ID = 'internal';

export function SitesManager({ tenantId = DEFAULT_TENANT_ID }: { tenantId?: string }) {
  const [items, setItems] = useState<SiteWithDevices[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/sites?tenantId=${encodeURIComponent(tenantId)}`);
    if (res.ok) setItems((await res.json()) as SiteWithDevices[]);
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = useCallback(async () => {
    if (name.trim() === '' || busy) return;
    setBusy(true);
    try {
      await fetch('/api/admin/sites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId, name }),
      });
      setName('');
      await load();
    } finally {
      setBusy(false);
    }
  }, [name, busy, tenantId, load]);

  const patch = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      await fetch(`/api/admin/sites/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId, ...body }),
      });
      await load();
    },
    [tenantId, load],
  );

  const toggle = useCallback(
    (s: SiteWithDevices) => patch(s.id, { status: s.status === 'active' ? 'suspended' : 'active' }),
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

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>拠点管理</h1>
      <p style={{ opacity: 0.7, marginTop: -8 }}>
        テナント <code>{tenantId}</code> 配下の受付拠点を管理します。各拠点に紐づく受付端末数を表示します。
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 24 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: '0.85rem', opacity: 0.8 }}>拠点名</span>
          <input
            data-testid="site-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={inputStyle}
          />
        </label>
        <button
          type="button"
          data-testid="site-add"
          onClick={add}
          disabled={busy || name.trim() === ''}
          style={btnStyle}
        >
          追加
        </button>
      </div>

      <table data-testid="site-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.2)' }}>
            <th style={th}>拠点名</th>
            <th style={th}>端末</th>
            <th style={th}>状態</th>
            <th style={th}>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr
              key={s.id}
              data-testid="site-row"
              style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}
            >
              <td style={td} data-testid="site-name">
                {editingId === s.id ? (
                  <input
                    data-testid="site-edit-input"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    style={inputStyle}
                  />
                ) : (
                  s.name
                )}
              </td>
              <td style={td} data-testid="site-devices">
                {s.onlineDeviceCount} / {s.deviceCount} オンライン
              </td>
              <td
                style={{ ...td, color: s.status === 'active' ? 'var(--color-success)' : 'var(--color-muted)' }}
              >
                {s.status === 'active' ? '有効' : '停止中'}
              </td>
              <td style={td}>
                <div style={{ display: 'flex', gap: 6 }}>
                  {editingId === s.id ? (
                    <>
                      <button type="button" data-testid="site-save" onClick={() => saveName(s.id)} style={smallBtn}>
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
                        data-testid="site-edit"
                        onClick={() => {
                          setEditingId(s.id);
                          setEditName(s.name);
                        }}
                        style={smallBtn}
                      >
                        名称編集
                      </button>
                      <button type="button" data-testid="site-toggle" onClick={() => toggle(s)} style={smallBtn}>
                        {s.status === 'active' ? '停止' : '再開'}
                      </button>
                    </>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
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
const th: React.CSSProperties = { padding: '8px 12px' };
const td: React.CSSProperties = { padding: '8px 12px' };
