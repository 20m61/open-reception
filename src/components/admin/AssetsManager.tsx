'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ActiveAssetSet, Asset, AssetKind } from '@/domain/assets/types';
import { Button, DataTable, Pager, Field, Form, FormRow, type Column } from '@/components/admin/ui';
import { color, space } from '@/components/admin/ui/tokens';
import { enablementState } from './state-vocabulary';
import { useQueryParams } from './use-query-params';
import { useTableSort } from './use-table-sort';
import { paginate, sortRows } from './list-io';

const KIND_LABEL: Record<AssetKind, string> = {
  background: '背景画像',
  vrm: 'VRM モデル',
  motion: 'モーション',
  fallbackImage: 'fallback 画像',
};

/** アセット管理 (issue #27)。登録・有効/無効・アクティブ選択を行う（URL 登録方式）。 */
const PAGE_SIZE = 20;

export function AssetsManager() {
  /*
   * 🔴 **「まだ読めていない」と「0 件だった」を型で分ける (#966 AC2)。**
   *
   * 初期値を `[]` にすると、取得前も取得失敗も「登録されたアセットはありません。」と
   * **断定**することになる。運用者は「無い」と信じて登録をやり直す。`null`（未読）と
   * 配列（読めた）で持ち、判断は `resolveAdminReadState` へ委ねる（`DataTable` が通す）。
   */
  const [items, setItems] = useState<Asset[] | null>(null);
  /** 一覧の読み取り失敗。**登録フォームの `error` とは別**（用途が違う）。 */
  const [listError, setListError] = useState<string | null>(null);
  const { get, setMany } = useQueryParams();
  const { sort, setSort } = useTableSort();
  const [active, setActive] = useState<ActiveAssetSet>({});
  const [kind, setKind] = useState<AssetKind>('background');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/assets');
      if (!res.ok) {
        setListError('アセット一覧を取得できませんでした。');
        return;
      }
      const data = (await res.json()) as { items: Asset[]; active: ActiveAssetSet };
      setListError(null);
      setItems(data.items);
      setActive(data.active);
    } catch {
      // 通信そのものの失敗も「失敗」へ落とす。拾わないと永遠の「読み込み中」になる (#966 AC3)。
      setListError('アセット一覧を取得できませんでした。');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = useCallback(async () => {
    if (name.trim() === '' || url.trim() === '' || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/admin/assets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, name, url }),
      });
      if (res.ok) {
        setName('');
        setUrl('');
        await load();
      } else {
        setError(((await res.json()) as { message?: string }).message ?? '登録に失敗しました');
      }
    } finally {
      setBusy(false);
    }
  }, [kind, name, url, busy, load]);

  const patch = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      await fetch(`/api/admin/assets/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      await load();
    },
    [load],
  );

  const columns = useMemo<Column<Asset>[]>(
    () => [
      { key: 'kind', header: '種別', cell: (a) => KIND_LABEL[a.kind], sortValue: (a) => KIND_LABEL[a.kind] },
      { key: 'name', header: '名称', cellTestId: () => 'asset-name-cell', cell: (a) => a.name, sortValue: (a) => a.name },
      {
        key: 'status',
        header: '状態',
        cellStyle: (a) => ({ color: enablementState(a.enabled).color }),
        cell: (a) => enablementState(a.enabled).label,
      },
      {
        key: 'active',
        header: '適用',
        cell: (a) => (active[a.kind] === a.id ? <strong data-testid="asset-active">適用中</strong> : '-'),
      },
      {
        key: 'actions',
        header: '操作',
        cell: (a) => (
          <div style={{ display: 'flex', gap: 6 }}>
            <Button data-testid="asset-activate" onClick={() => patch(a.id, { active: true })} disabled={!a.enabled}>
              適用
            </Button>
            <Button data-testid="asset-toggle" onClick={() => patch(a.id, { enabled: !a.enabled })}>
              {a.enabled ? '無効化' : '有効化'}
            </Button>
          </div>
        ),
      },
    ],
    [active, patch],
  );

  const sorted = useMemo(() => sortRows(items ?? [], columns, sort), [items, columns, sort]);
  const paged = useMemo(() => paginate(sorted, Number(get('page')) || 1, PAGE_SIZE), [sorted, get]);

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>アセット管理</h1>

      <Form onSubmit={add} aria-label="アセットを登録">
        <FormRow>
          <Field label="種別" htmlFor="asset-kind">
            <select id="asset-kind" data-testid="asset-kind" value={kind} onChange={(e) => setKind(e.target.value as AssetKind)} style={input}>
              {(Object.keys(KIND_LABEL) as AssetKind[]).map((k) => (
                <option key={k} value={k}>{KIND_LABEL[k]}</option>
              ))}
            </select>
          </Field>
          <Field label="名称" htmlFor="asset-name">
            <input id="asset-name" data-testid="asset-name" value={name} onChange={(e) => setName(e.target.value)} style={input} />
          </Field>
          <Field label="URL（拡張子で形式検証）" htmlFor="asset-url">
            <input id="asset-url" data-testid="asset-url" value={url} onChange={(e) => setUrl(e.target.value)} style={{ ...input, minWidth: 260 }} />
          </Field>
          <Button variant="primary" type="submit" data-testid="asset-add" disabled={busy}>登録</Button>
        </FormRow>
      </Form>
      {error ? <p data-testid="asset-error" style={{ color: color.danger }}>{error}</p> : null}

      <div style={{ marginTop: space.sm }}>
        <DataTable
          testId="asset-table"
          columns={columns}
          rows={paged.items}
          rowKey={(a) => a.id}
          rowTestId={() => 'asset-row'}
          sort={sort}
          onSortChange={setSort}
          loaded={items !== null}
          failed={listError !== null}
          emptyMessage="登録されたアセットはありません。"
          failureMessage="アセット一覧を読み込めませんでした。"
          scrollRegionLabel="アセット一覧"
        />

        <Pager
          page={paged.page}
          pageCount={paged.pageCount}
          onChange={(next) => setMany({ page: String(next) })}
          testIdPrefix="asset"
        />
      </div>
    </section>
  );
}

const input: React.CSSProperties = {
  minHeight: 40, padding: '8px 12px', borderRadius: 8,
  border: '1px solid var(--color-surface-2)', background: 'var(--color-surface)', color: 'var(--color-text)',
};
