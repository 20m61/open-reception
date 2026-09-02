'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Department } from '@/domain/department/types';
import type { Staff } from '@/domain/staff/types';
import { CsvImport } from './CsvImport';
import { StaffEditor } from './StaffEditor';
import { filterStaff, type StaffStatusFilter } from './staff-filter';
import { useQueryParams } from './use-query-params';
import { Button, DataTable, Field, SaveFeedback, useSaveFeedback, type Column } from '@/components/admin/ui';
import { color, space } from '@/components/admin/ui/tokens';

/**
 * 担当者管理 (issue #26; 検索/フィルタ #330 item2)。
 * 一覧・作成・有効/無効・部署割り当てを管理 API 経由で行う。
 * 検索/フィルタ状態は監査ログ・受付履歴と同じく URL クエリを真実源にする（issue #94）。
 */
export function StaffManager() {
  const [items, setItems] = useState<Staff[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  /** 担当者 id → 兼務している組織 id。主所属（`staff.departmentId`）は含まない (#373 増分 8)。 */
  const [secondary, setSecondary] = useState<Record<string, string[]>>({});
  const [displayName, setDisplayName] = useState('');
  const [kana, setKana] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [busy, setBusy] = useState(false);
  const { feedback, success, failure, clear } = useSaveFeedback();
  const [editingId, setEditingId] = useState<string | null>(null);

  const { get, setMany } = useQueryParams();
  const keyword = get('q');
  const filterDeptId = get('dept');
  const status = get('status');

  const load = useCallback(async () => {
    const [sRes, dRes, oRes] = await Promise.all([
      fetch('/api/admin/staff'),
      fetch('/api/admin/departments'),
      // 兼務は組織ビュー（互換 + 保存済みの合成）から読む。保存済みだけを見ると
      // 「一覧に出ているのに設定できない」になる。
      fetch('/api/admin/organizations/memberships'),
    ]);
    if (oRes.ok) {
      const body = (await oRes.json()) as { items: { staffId: string; organizationId: string; relation: string }[] };
      const map: Record<string, string[]> = {};
      for (const m of body.items) {
        if (m.relation !== 'secondary') continue;
        (map[m.staffId] ??= []).push(m.organizationId);
      }
      setSecondary(map);
    }
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
    clear();
    try {
      /*
        **結果を捨てない (#870 増分 02)。** 戻りを見ずに `load()` すると、403 / 409 / 5xx でも
        入力欄が空になって一覧が元のまま返るだけになり、運用者には「登録した」ように見える。
      */
      const res = await fetch('/api/admin/staff', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName, kana: kana || undefined, departmentId }),
      }).catch(() => null);
      if (!res?.ok) {
        failure('担当者を追加できませんでした。');
        return;
      }
      setDisplayName('');
      setKana('');
      await load();
      success('担当者を追加しました。');
    } finally {
      setBusy(false);
    }
  }, [displayName, kana, departmentId, busy, load, clear, success, failure]);

  const patch = useCallback(
    async (s: Staff, body: Record<string, unknown>) => {
      clear();
      const res = await fetch(`/api/admin/staff/${s.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => null);
      if (!res?.ok) {
        // 失敗したら `load()` しない。取り直すと行が元へ戻り、**何も起きなかったのか
        // 失敗したのかが区別できない**（viewer が在席を切り替えたつもりで切り替わっていない）。
        failure('変更を保存できませんでした。');
        return;
      }
      await load();
      success('変更を保存しました。');
    },
    [load, clear, success, failure],
  );

  const deptName = useCallback(
    (id: string) => departments.find((d) => d.id === id)?.name ?? '-',
    [departments],
  );

  const filtered = useMemo(
    () =>
      filterStaff(items, {
        keyword: keyword || undefined,
        departmentId: filterDeptId || undefined,
        status: (status as StaffStatusFilter) || undefined,
      }),
    [items, keyword, filterDeptId, status],
  );
  const changeSecondary = useCallback(
    async (staffId: string, organizationId: string, method: 'POST' | 'DELETE') => {
      clear();
      const res = await fetch(`/api/admin/staff/${staffId}/memberships`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId }),
      }).catch(() => null);
      if (!res?.ok) {
        failure(method === 'POST' ? '兼務を追加できませんでした。' : '兼務を外せませんでした。');
        return;
      }
      await load();
      success(method === 'POST' ? '兼務を追加しました。' : '兼務を外しました。');
    },
    [load, clear, success, failure],
  );

  const hasFilter = Boolean(keyword || filterDeptId || status);

  const columns = useMemo<Column<Staff>[]>(
    () => [
      {
        key: 'name',
        header: '氏名',
        cellTestId: () => 'staff-name',
        cell: (s) => (
          <>
            {s.displayName}
            {s.kana ? <span style={{ opacity: 0.6 }}>（{s.kana}）</span> : null}
          </>
        ),
      },
      { key: 'dept', header: '部署', cell: (s) => deptName(s.departmentId) },
      {
        key: 'secondary',
        header: '兼務',
        // 兼務は来訪者の候補カードに「営業部（兼: 技術部）」として出る (#590)。
        // 設定経路が無いとその表示は永久に空のままなので、ここで足し引きできるようにする。
        cell: (s) => (
          <span style={{ display: 'inline-flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            {(secondary[s.id] ?? []).map((orgId) => (
              <span key={orgId} data-testid={`staff-${s.id}-secondary-${orgId}`}>
                {deptName(orgId)}
                <button
                  type="button"
                  data-testid={`staff-${s.id}-secondary-remove-${orgId}`}
                  onClick={() => void changeSecondary(s.id, orgId, 'DELETE')}
                  aria-label={`${deptName(orgId)} の兼務を外す`}
                >
                  ×
                </button>
              </span>
            ))}
            <select
              data-testid={`staff-${s.id}-secondary-add`}
              value=""
              onChange={(e) => {
                if (e.target.value !== '') void changeSecondary(s.id, e.target.value, 'POST');
              }}
            >
              <option value="">兼務を追加…</option>
              {departments
                // 主所属と既存の兼務は候補から外す（追加しても 400 になるだけ）。
                .filter((d) => d.id !== s.departmentId && !(secondary[s.id] ?? []).includes(d.id))
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
            </select>
          </span>
        ),
      },
      {
        key: 'status',
        header: '状態',
        cellStyle: (s) => ({ color: s.enabled ? color.success : color.muted }),
        cell: (s) => (s.enabled ? '有効' : '無効'),
      },
      {
        key: 'availability',
        header: '在席',
        cellTestId: () => 'staff-availability',
        cellStyle: (s) => ({ color: s.available ? color.success : color.warning }),
        cell: (s) => (s.available ? '在席' : '不在'),
      },
      {
        key: 'actions',
        header: '操作',
        cell: (s) => (
          <>
            <div style={{ display: 'flex', gap: 6 }}>
              <Button data-testid="staff-availability-toggle" onClick={() => patch(s, { available: !s.available })}>
                {s.available ? '不在にする' : '在席にする'}
              </Button>
              <Button data-testid="staff-toggle" onClick={() => patch(s, { enabled: !s.enabled })}>
                {s.enabled ? '無効化' : '有効化'}
              </Button>
              <Button
                data-testid="staff-edit"
                onClick={() => setEditingId((cur) => (cur === s.id ? null : s.id))}
              >
                {editingId === s.id ? '閉じる' : '呼び出し先'}
              </Button>
            </div>
            {editingId === s.id ? (
              <StaffEditor
                staff={s}
                allStaff={items}
                onSaved={() => {
                  setEditingId(null);
                  void load();
                }}
              />
            ) : null}
          </>
        ),
      },
    ],
    [deptName, patch, editingId, items, load, secondary, departments, changeSecondary],
  );

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>担当者管理</h1>

      <div style={{ display: 'flex', gap: space.sm, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: space.lg }}>
        <Field label="氏名" htmlFor="staff-name-input">
          <input id="staff-name-input" data-testid="staff-name-input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="よみがな（任意）" htmlFor="staff-kana-input">
          <input id="staff-kana-input" data-testid="staff-kana-input" value={kana} onChange={(e) => setKana(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="部署" htmlFor="staff-dept-select">
          <select id="staff-dept-select" data-testid="staff-dept-select" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} style={inputStyle}>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <Button variant="primary" data-testid="staff-add" onClick={add} disabled={busy || displayName.trim() === ''}>
          追加
        </Button>
        <SaveFeedback feedback={feedback} successTestId="staff-saved" errorTestId="staff-save-error" />
      </div>

      <CsvImport
        endpoint="/api/admin/staff/import"
        placeholder={'staff_id,display_name,kana,aliases,department_id,enabled,available\n,新任 太郎,しんにん たろう,Shinnin,dept-sales,true,true'}
        onApplied={() => void load()}
        testId="staff"
      />

      <div
        data-testid="staff-filters"
        style={{ display: 'flex', gap: space.sm, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: space.lg }}
      >
        <Field label="氏名・よみがなで検索" htmlFor="staff-filter-keyword">
          <input
            id="staff-filter-keyword"
            data-testid="staff-filter-keyword"
            value={keyword}
            onChange={(e) => setMany({ q: e.target.value })}
            style={inputStyle}
          />
        </Field>
        <Field label="部署で絞り込み" htmlFor="staff-filter-dept">
          <select
            id="staff-filter-dept"
            data-testid="staff-filter-dept"
            value={filterDeptId}
            onChange={(e) => setMany({ dept: e.target.value })}
            style={inputStyle}
          >
            <option value="">すべて</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="状態で絞り込み" htmlFor="staff-filter-status">
          <select
            id="staff-filter-status"
            data-testid="staff-filter-status"
            value={status}
            onChange={(e) => setMany({ status: e.target.value })}
            style={inputStyle}
          >
            <option value="">すべて</option>
            <option value="enabled">有効</option>
            <option value="disabled">無効</option>
          </select>
        </Field>
        {hasFilter ? (
          <Button
            variant="secondary"
            data-testid="staff-filter-reset"
            onClick={() => setMany({ q: '', dept: '', status: '' })}
          >
            条件をクリア
          </Button>
        ) : null}
      </div>
      <p data-testid="staff-count" style={{ opacity: 0.7, fontSize: '0.85rem' }}>
        {items.length} 件中 {filtered.length} 件を表示
      </p>

      <DataTable
        testId="staff-table"
        columns={columns}
        rows={filtered}
        rowKey={(s) => s.id}
        rowTestId={() => 'staff-row'}
        emptyMessage={hasFilter ? '条件に一致する担当者はいません。' : '登録された担当者はありません。'}
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
