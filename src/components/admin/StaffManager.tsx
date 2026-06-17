'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Department } from '@/domain/department/types';
import type { Staff } from '@/domain/staff/types';

/** 担当者管理 (issue #26)。一覧・作成・有効/無効・部署割り当てを管理 API 経由で行う。 */
export function StaffManager() {
  const [items, setItems] = useState<Staff[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [kana, setKana] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [sRes, dRes] = await Promise.all([fetch('/api/admin/staff'), fetch('/api/admin/departments')]);
    if (sRes.ok) setItems(((await sRes.json()) as { items: Staff[] }).items);
    if (dRes.ok) {
      const depts = ((await dRes.json()) as { items: Department[] }).items;
      setDepartments(depts);
      setDepartmentId((prev) => prev || depts[0]?.id || '');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = useCallback(async () => {
    if (displayName.trim() === '' || departmentId === '' || busy) return;
    setBusy(true);
    try {
      await fetch('/api/admin/staff', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName, kana: kana || undefined, departmentId }),
      });
      setDisplayName('');
      setKana('');
      await load();
    } finally {
      setBusy(false);
    }
  }, [displayName, kana, departmentId, busy, load]);

  const toggle = useCallback(
    async (s: Staff) => {
      await fetch(`/api/admin/staff/${s.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      await load();
    },
    [load],
  );

  const deptName = (id: string) => departments.find((d) => d.id === id)?.name ?? '-';

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>担当者管理</h1>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 24 }}>
        <label style={col}>
          <span style={lbl}>氏名</span>
          <input data-testid="staff-name-input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} style={inputStyle} />
        </label>
        <label style={col}>
          <span style={lbl}>よみがな（任意）</span>
          <input data-testid="staff-kana-input" value={kana} onChange={(e) => setKana(e.target.value)} style={inputStyle} />
        </label>
        <label style={col}>
          <span style={lbl}>部署</span>
          <select data-testid="staff-dept-select" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} style={inputStyle}>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" data-testid="staff-add" onClick={add} disabled={busy || displayName.trim() === ''} style={btnStyle}>
          追加
        </button>
      </div>

      <table data-testid="staff-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.2)' }}>
            <th style={cell}>氏名</th>
            <th style={cell}>部署</th>
            <th style={cell}>状態</th>
            <th style={cell}>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.id} data-testid="staff-row" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <td style={cell} data-testid="staff-name">
                {s.displayName}
                {s.kana ? <span style={{ opacity: 0.6 }}>（{s.kana}）</span> : null}
              </td>
              <td style={cell}>{deptName(s.departmentId)}</td>
              <td style={{ ...cell, color: s.enabled ? 'var(--color-success)' : 'var(--color-muted)' }}>
                {s.enabled ? '有効' : '無効'}
              </td>
              <td style={cell}>
                <button type="button" data-testid="staff-toggle" onClick={() => toggle(s)} style={smallBtn}>
                  {s.enabled ? '無効化' : '有効化'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const col: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 };
const lbl: React.CSSProperties = { fontSize: '0.85rem', opacity: 0.8 };
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
const cell: React.CSSProperties = { padding: '8px 12px' };
