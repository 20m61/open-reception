'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SiteWithDevices } from '@/lib/tenant/site-service';
import { Button, DataTable, Field, type Column } from '@/components/admin/ui';
import { color, space } from '@/components/admin/ui/tokens';

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

  const columns = useMemo<Column<SiteWithDevices>[]>(
    () => [
      {
        key: 'name',
        header: '拠点名',
        cellTestId: () => 'site-name',
        cell: (s) =>
          editingId === s.id ? (
            <input
              data-testid="site-edit-input"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              style={inputStyle}
            />
          ) : (
            s.name
          ),
      },
      {
        key: 'devices',
        header: '端末',
        cellTestId: () => 'site-devices',
        cell: (s) => `${s.onlineDeviceCount} / ${s.deviceCount} オンライン`,
      },
      {
        key: 'status',
        header: '状態',
        cellStyle: (s) => ({ color: s.status === 'active' ? color.success : color.muted }),
        cell: (s) => (s.status === 'active' ? '有効' : '停止中'),
      },
      {
        key: 'actions',
        header: '操作',
        cell: (s) => (
          <div style={{ display: 'flex', gap: 6 }}>
            {editingId === s.id ? (
              <>
                <Button data-testid="site-save" onClick={() => saveName(s.id)}>
                  保存
                </Button>
                <Button onClick={() => setEditingId(null)}>取消</Button>
              </>
            ) : (
              <>
                <Button
                  data-testid="site-edit"
                  onClick={() => {
                    setEditingId(s.id);
                    setEditName(s.name);
                  }}
                >
                  名称編集
                </Button>
                <Button data-testid="site-toggle" onClick={() => toggle(s)}>
                  {s.status === 'active' ? '停止' : '再開'}
                </Button>
              </>
            )}
          </div>
        ),
      },
    ],
    [editingId, editName, saveName, toggle],
  );

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>拠点管理</h1>
      <p style={{ opacity: 0.7, marginTop: -8 }}>
        テナント <code>{tenantId}</code> 配下の受付拠点を管理します。各拠点に紐づく受付端末数を表示します。
      </p>

      <div style={{ display: 'flex', gap: space.sm, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: space.lg }}>
        <Field label="拠点名" htmlFor="site-name-input">
          <input
            id="site-name-input"
            data-testid="site-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={inputStyle}
          />
        </Field>
        <Button variant="primary" data-testid="site-add" onClick={add} disabled={busy || name.trim() === ''}>
          追加
        </Button>
      </div>

      <DataTable
        testId="site-table"
        columns={columns}
        rows={items}
        rowKey={(s) => s.id}
        rowTestId={() => 'site-row'}
        emptyMessage="このテナントに登録された拠点はありません。"
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
