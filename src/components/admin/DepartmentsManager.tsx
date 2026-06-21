'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Department } from '@/domain/department/types';
import { CsvImport } from './CsvImport';
import { Button, DataTable, Field, type Column } from '@/components/admin/ui';
import { color, space } from '@/components/admin/ui/tokens';

/** 部署管理 (issue #25)。一覧・作成・有効/無効・並び替えを管理 API 経由で行う。 */
export function DepartmentsManager() {
  const [items, setItems] = useState<Department[]>([]);
  const [name, setName] = useState('');
  const [kana, setKana] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

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

  // DnD で並び替える (issue #25)。確定順序を reorder API へ送る。
  const handleDrop = useCallback(
    async (targetIndex: number) => {
      if (dragIndex === null || dragIndex === targetIndex) return setDragIndex(null);
      const next = [...items];
      const [moved] = next.splice(dragIndex, 1);
      if (moved) next.splice(targetIndex, 0, moved);
      setItems(next);
      setDragIndex(null);
      await fetch('/api/admin/departments/reorder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderedIds: next.map((d) => d.id) }),
      });
      await load();
    },
    [dragIndex, items, load],
  );

  const columns = useMemo<Column<Department>[]>(() => {
    const indexOf = (d: Department) => items.findIndex((x) => x.id === d.id);
    return [
      {
        key: 'order',
        header: '順',
        cell: (d) => <span title="ドラッグで並び替え">⠿ {indexOf(d) + 1}</span>,
      },
      {
        key: 'name',
        header: '部署名',
        cellTestId: () => 'dept-name',
        cell: (d) => (
          <>
            {d.name}
            {d.kana ? <span style={{ opacity: 0.6 }}>（{d.kana}）</span> : null}
          </>
        ),
      },
      {
        key: 'status',
        header: '状態',
        cellStyle: (d) => ({ color: d.enabled ? color.success : color.muted }),
        cell: (d) => (d.enabled ? '有効' : '無効'),
      },
      {
        key: 'actions',
        header: '操作',
        cell: (d) => {
          const i = indexOf(d);
          return (
            <div style={{ display: 'flex', gap: 6 }}>
              <Button aria-label="up" onClick={() => move(d, 'up')} disabled={i === 0}>
                ↑
              </Button>
              <Button aria-label="down" onClick={() => move(d, 'down')} disabled={i === items.length - 1}>
                ↓
              </Button>
              <Button data-testid="dept-toggle" onClick={() => toggle(d)}>
                {d.enabled ? '無効化' : '有効化'}
              </Button>
            </div>
          );
        },
      },
    ];
  }, [items, move, toggle]);

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>部署管理</h1>

      <div style={{ display: 'flex', gap: space.sm, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: space.lg }}>
        <Field label="部署名" htmlFor="dept-name-input">
          <input id="dept-name-input" data-testid="dept-name-input" value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="よみがな（任意）" htmlFor="dept-kana-input">
          <input id="dept-kana-input" data-testid="dept-kana-input" value={kana} onChange={(e) => setKana(e.target.value)} style={inputStyle} />
        </Field>
        <Button variant="primary" data-testid="dept-add" onClick={add} disabled={busy || name.trim() === ''}>
          追加
        </Button>
      </div>

      <CsvImport
        endpoint="/api/admin/departments/import"
        placeholder={'department_id,name,kana,display_order,enabled\n,法務部,ほうむぶ,5,true'}
        onApplied={() => void load()}
        testId="dept"
      />

      <DataTable
        testId="dept-table"
        columns={columns}
        rows={items}
        rowKey={(d) => d.id}
        rowTestId={() => 'dept-row'}
        rowProps={(_d, i) => ({
          draggable: true,
          onDragStart: () => setDragIndex(i),
          onDragOver: (e) => e.preventDefault(),
          onDrop: () => handleDrop(i),
          style: { cursor: 'grab' },
        })}
        emptyMessage="登録された部署はありません。"
      />
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
