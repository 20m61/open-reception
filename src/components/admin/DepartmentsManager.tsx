'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Department } from '@/domain/department/types';
import { CsvImport } from './CsvImport';
import { Button, DataTable, Field, Form, Pager, SaveFeedback, useSaveFeedback, type Column } from '@/components/admin/ui';
import { paginate, sortRows } from './list-io';
import { useQueryParams } from './use-query-params';
import { useTableSort } from './use-table-sort';
import { space } from '@/components/admin/ui/tokens';
import { enablementState } from './state-vocabulary';

const PAGE_SIZE = 20;

/** 部署管理 (issue #25)。一覧・作成・有効/無効・並び替えを管理 API 経由で行う。 */
export function DepartmentsManager() {
  const [items, setItems] = useState<Department[]>([]);
  const [name, setName] = useState('');
  const [kana, setKana] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const { feedback, success, failure, clear } = useSaveFeedback();
  const { get, setMany } = useQueryParams();
  const { sort, setSort } = useTableSort();

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
    clear();
    try {
      /*
        **結果を捨てない (#870 増分 02)。** 戻りを見ずに `load()` すると、403 / 409 / 5xx でも
        入力欄が空になって一覧が元のまま返るだけになり、運用者には「登録した」ように見える。
      */
      const res = await fetch('/api/admin/departments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, kana: kana || undefined }),
      }).catch(() => null);
      if (!res?.ok) {
        failure('部署を追加できませんでした。');
        return;
      }
      setName('');
      setKana('');
      await load();
      success('部署を追加しました。');
    } finally {
      setBusy(false);
    }
  }, [name, kana, busy, load, clear, success, failure]);

  const toggle = useCallback(
    async (d: Department) => {
      clear();
      const res = await fetch(`/api/admin/departments/${d.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !d.enabled }),
      }).catch(() => null);
      if (!res?.ok) {
        // 失敗したら `load()` しない。取り直すと行が元へ戻り、**何も起きなかったのか
        // 失敗したのかが区別できない**（無効化したつもりで無効化できていない、が起こる）。
        failure(d.enabled ? '無効化できませんでした。' : '有効化できませんでした。');
        return;
      }
      await load();
      success(d.enabled ? '無効にしました。' : '有効にしました。');
    },
    [load, clear, success, failure],
  );

  const move = useCallback(
    async (d: Department, direction: 'up' | 'down') => {
      clear();
      const res = await fetch(`/api/admin/departments/${d.id}/move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ direction }),
      }).catch(() => null);
      if (!res?.ok) {
        failure('並び順を変更できませんでした。');
        return;
      }
      await load();
    },
    [load, clear, failure],
  );

  // DnD で並び替える (issue #25)。確定順序を reorder API へ送る。
  const handleDrop = useCallback(
    async (targetIndex: number) => {
      if (dragIndex === null || dragIndex === targetIndex) return setDragIndex(null);
      const next = [...items];
      const [moved] = next.splice(dragIndex, 1);
      if (moved) next.splice(targetIndex, 0, moved);
      // 先に画面上の並びを動かしているので、失敗したときは**必ず取り直して戻す**。
      // 戻さないと、保存されていない並びが正しいものとして残る。
      setItems(next);
      setDragIndex(null);
      clear();
      const res = await fetch('/api/admin/departments/reorder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderedIds: next.map((d) => d.id) }),
      }).catch(() => null);
      if (!res?.ok) {
        failure('並び順を保存できませんでした。');
        await load();
        return;
      }
      await load();
    },
    [dragIndex, items, load, clear, failure],
  );

  const indexInItems = useCallback((d: Department) => items.findIndex((x) => x.id === d.id), [items]);

  const columns = useMemo<Column<Department>[]>(() => {
    const indexOf = (d: Department) => items.findIndex((x) => x.id === d.id);
    return [
      {
        key: 'order',
        header: '順',
        // 既定の並び（表示順）へ戻す口。解除ではなくこの列で昇順に並べても同じ順になる。
        sortValue: (d) => indexOf(d),
        cell: (d) => <span title="ドラッグで並び替え">⠿ {indexOf(d) + 1}</span>,
      },
      {
        key: 'name',
        header: '部署名',
        cellTestId: () => 'dept-name',
        sortValue: (d) => d.name,
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
        cellStyle: (d) => ({ color: enablementState(d.enabled).color }),
        cell: (d) => enablementState(d.enabled).label,
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

  const sorted = useMemo(() => sortRows(items, columns, sort), [items, columns, sort]);
  const paged = useMemo(() => paginate(sorted, Number(get('page')) || 1, PAGE_SIZE), [sorted, get]);
  /*
   * ドラッグでの並び替えは**既定の並びのままでないと意味を持たない**。並べ替え中や
   * 2 ページ目では掴んだ位置と実際の位置が食い違うので、掴めなくする。
   */
  const reorderable = sort === undefined && paged.pageCount === 1;

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>部署管理</h1>

      <Form
        onSubmit={add}
        aria-label="部署を追加"
        style={{ display: 'flex', gap: space.sm, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: space.lg }}
      >
        <Field label="部署名" htmlFor="dept-name-input">
          <input id="dept-name-input" data-testid="dept-name-input" value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="よみがな（任意）" htmlFor="dept-kana-input">
          <input id="dept-kana-input" data-testid="dept-kana-input" value={kana} onChange={(e) => setKana(e.target.value)} style={inputStyle} />
        </Field>
        <Button variant="primary" type="submit" data-testid="dept-add" disabled={busy || name.trim() === ''}>
          追加
        </Button>
        <SaveFeedback feedback={feedback} successTestId="dept-saved" errorTestId="dept-save-error" />
      </Form>

      <CsvImport
        endpoint="/api/admin/departments/import"
        placeholder={'department_id,name,kana,display_order,enabled\n,法務部,ほうむぶ,5,true'}
        onApplied={() => void load()}
        testId="dept"
      />

      <DataTable
        testId="dept-table"
        columns={columns}
        rows={paged.items}
        rowKey={(d) => d.id}
        rowTestId={() => 'dept-row'}
        /*
         * 🔴 **並べ替え中はドラッグさせない。** 並び替えは `items` の**位置**を書き換える
         * 操作なので、表示が別の順序になっている間に掴むと、掴んだ行と動く行が食い違う。
         * さらに index は**描画中の配列**のものなので、`items` 上の位置へ必ず引き直す
         * （ページを切ると 2 ページ目の 1 行目が index 0 になり、先頭へ飛ぶ）。
         */
        rowProps={
          reorderable
            ? (d) => ({
                draggable: true,
                onDragStart: () => setDragIndex(indexInItems(d)),
                onDragOver: (e) => e.preventDefault(),
                onDrop: () => handleDrop(indexInItems(d)),
                style: { cursor: 'grab' },
              })
            : undefined
        }
        sort={sort}
        onSortChange={setSort}
        emptyMessage="登録された部署はありません。"
      />

      <Pager
        page={paged.page}
        pageCount={paged.pageCount}
        onChange={(next) => setMany({ page: String(next) })}
        testIdPrefix="dept"
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
