'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Department } from '@/domain/department/types';
import { CsvImport } from './CsvImport';

/** 部署管理 (issue #25)。一覧・作成・有効/無効・並び替えを管理 API 経由で行う。 */
export function DepartmentsManager() {
  const [items, setItems] = useState<Department[]>([]);
  const [name, setName] = useState('');
  const [kana, setKana] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/departments');
    if (res.ok) setItems(((await res.json()) as { items: Department[] }).items);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = useCallback(async () => {
    if (name.trim() === '' || busy) return;
    setBusy(true);
    try {
      await fetch('/api/admin/departments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, kana: kana || undefined }),
      });
      setName('');
      setKana('');
      await load();
    } finally {
      setBusy(false);
    }
  }, [name, kana, busy, load]);

  const toggle = useCallback(
    async (d: Department) => {
      await fetch(`/api/admin/departments/${d.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !d.enabled }),
      });
      await load();
    },
    [load],
  );

  const move = useCallback(
    async (d: Department, direction: 'up' | 'down') => {
      await fetch(`/api/admin/departments/${d.id}/move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ direction }),
      });
      await load();
    },
    [load],
  );

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>部署管理</h1>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 24 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: '0.85rem', opacity: 0.8 }}>部署名</span>
          <input
            data-testid="dept-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={inputStyle}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: '0.85rem', opacity: 0.8 }}>よみがな（任意）</span>
          <input data-testid="dept-kana-input" value={kana} onChange={(e) => setKana(e.target.value)} style={inputStyle} />
        </label>
        <button type="button" data-testid="dept-add" onClick={add} disabled={busy || name.trim() === ''} style={btnStyle}>
          追加
        </button>
      </div>

      <CsvImport
        endpoint="/api/admin/departments/import"
        placeholder={'department_id,name,kana,display_order,enabled\n,法務部,ほうむぶ,5,true'}
        onApplied={() => void load()}
        testId="dept"
      />

      <table data-testid="dept-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.2)' }}>
            <th style={th}>順</th>
            <th style={th}>部署名</th>
            <th style={th}>状態</th>
            <th style={th}>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((d, i) => (
            <tr key={d.id} data-testid="dept-row" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <td style={td}>{i + 1}</td>
              <td style={td} data-testid="dept-name">
                {d.name}
                {d.kana ? <span style={{ opacity: 0.6 }}>（{d.kana}）</span> : null}
              </td>
              <td style={{ ...td, color: d.enabled ? 'var(--color-success)' : 'var(--color-muted)' }}>
                {d.enabled ? '有効' : '無効'}
              </td>
              <td style={td}>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" aria-label="up" onClick={() => move(d, 'up')} disabled={i === 0} style={smallBtn}>
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label="down"
                    onClick={() => move(d, 'down')}
                    disabled={i === items.length - 1}
                    style={smallBtn}
                  >
                    ↓
                  </button>
                  <button type="button" data-testid="dept-toggle" onClick={() => toggle(d)} style={smallBtn}>
                    {d.enabled ? '無効化' : '有効化'}
                  </button>
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
