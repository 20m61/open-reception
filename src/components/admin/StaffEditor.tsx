'use client';

import { useCallback, useState } from 'react';
import { CALL_TARGET_TYPES, type CallTarget, type Staff } from '@/domain/staff/types';

/** 担当者の呼び出し先（優先順位 DnD）と代替担当者を編集する (issue #26)。 */
export function StaffEditor({ staff, allStaff, onSaved }: { staff: Staff; allStaff: Staff[]; onSaved: () => void }) {
  const [targets, setTargets] = useState<CallTarget[]>(staff.callTargets);
  const [fallbacks, setFallbacks] = useState<string[]>(staff.fallbackStaffIds);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const update = (i: number, patch: Partial<CallTarget>) =>
    setTargets((cur) => cur.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));

  const addTarget = () =>
    setTargets((cur) => [...cur, { type: 'vonage', value: '', priority: cur.length, enabled: true }]);

  const removeTarget = (i: number) => setTargets((cur) => cur.filter((_, idx) => idx !== i));

  const reorder = (from: number, to: number) =>
    setTargets((cur) => {
      if (to < 0 || to >= cur.length) return cur;
      const next = [...cur];
      const [moved] = next.splice(from, 1);
      if (moved) next.splice(to, 0, moved);
      return next;
    });

  const toggleFallback = (id: string) =>
    setFallbacks((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const save = useCallback(async () => {
    setBusy(true);
    try {
      await fetch(`/api/admin/staff/${staff.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callTargets: targets.filter((t) => t.value.trim() !== ''), fallbackStaffIds: fallbacks }),
      });
      onSaved();
    } finally {
      setBusy(false);
    }
  }, [staff.id, targets, fallbacks, onSaved]);

  return (
    <div data-testid="staff-editor" style={{ padding: 12, background: 'var(--color-surface)', borderRadius: 8, marginTop: 8 }}>
      <h3 style={{ margin: '0 0 8px' }}>呼び出し先（優先順位順・ドラッグで並び替え）</h3>
      {targets.map((t, i) => (
        <div
          key={i}
          data-testid="ct-row"
          draggable
          onDragStart={() => setDragIndex(i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            if (dragIndex !== null) reorder(dragIndex, i);
            setDragIndex(null);
          }}
          style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, cursor: 'grab' }}
        >
          <span title="ドラッグで並び替え">⠿</span>
          <select data-testid="ct-type" value={t.type} onChange={(e) => update(i, { type: e.target.value as CallTarget['type'] })} style={field}>
            {CALL_TARGET_TYPES.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
          <input data-testid="ct-value" value={t.value} onChange={(e) => update(i, { value: e.target.value })} placeholder="値" style={{ ...field, flex: 1 }} />
          <label style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: '0.85rem' }}>
            <input type="checkbox" checked={t.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} />有効
          </label>
          <button type="button" aria-label="up" onClick={() => reorder(i, i - 1)} disabled={i === 0} style={small}>↑</button>
          <button type="button" aria-label="down" onClick={() => reorder(i, i + 1)} disabled={i === targets.length - 1} style={small}>↓</button>
          <button type="button" data-testid="ct-remove" onClick={() => removeTarget(i)} style={small}>削除</button>
        </div>
      ))}
      <button type="button" data-testid="ct-add" onClick={addTarget} style={small}>＋ 呼び出し先を追加</button>

      <h3 style={{ margin: '16px 0 8px' }}>代替担当者</h3>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {allStaff.filter((s) => s.id !== staff.id).map((s) => (
          <label key={s.id} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: '0.9rem' }}>
            <input type="checkbox" data-testid={`fallback-${s.id}`} checked={fallbacks.includes(s.id)} onChange={() => toggleFallback(s.id)} />
            {s.displayName}
          </label>
        ))}
      </div>

      <div style={{ marginTop: 12 }}>
        <button type="button" data-testid="staff-editor-save" onClick={save} disabled={busy} style={primary}>保存</button>
      </div>
    </div>
  );
}

const field: React.CSSProperties = {
  minHeight: 36, padding: '6px 10px', borderRadius: 8,
  border: '1px solid var(--color-surface-2)', background: 'var(--color-bg)', color: 'var(--color-text)',
};
const small: React.CSSProperties = {
  padding: '6px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.2)',
  background: 'var(--color-bg)', color: 'var(--color-text)', cursor: 'pointer',
};
const primary: React.CSSProperties = {
  minHeight: 40, padding: '8px 16px', borderRadius: 8, border: 'none',
  background: 'var(--color-accent)', color: '#0f172a', fontWeight: 700, cursor: 'pointer',
};
