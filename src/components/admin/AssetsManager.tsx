'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ActiveAssetSet, Asset, AssetKind } from '@/domain/assets/types';

const KIND_LABEL: Record<AssetKind, string> = {
  background: '背景画像',
  vrm: 'VRM モデル',
  motion: 'モーション',
  fallbackImage: 'fallback 画像',
};

/** アセット管理 (issue #27)。登録・有効/無効・アクティブ選択を行う（URL 登録方式）。 */
export function AssetsManager() {
  const [items, setItems] = useState<Asset[]>([]);
  const [active, setActive] = useState<ActiveAssetSet>({});
  const [kind, setKind] = useState<AssetKind>('background');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/assets');
    if (res.ok) {
      const data = (await res.json()) as { items: Asset[]; active: ActiveAssetSet };
      setItems(data.items);
      setActive(data.active);
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

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>アセット管理</h1>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 8 }}>
        <label style={col}>
          <span style={lbl}>種別</span>
          <select data-testid="asset-kind" value={kind} onChange={(e) => setKind(e.target.value as AssetKind)} style={input}>
            {(Object.keys(KIND_LABEL) as AssetKind[]).map((k) => (
              <option key={k} value={k}>{KIND_LABEL[k]}</option>
            ))}
          </select>
        </label>
        <label style={col}>
          <span style={lbl}>名称</span>
          <input data-testid="asset-name" value={name} onChange={(e) => setName(e.target.value)} style={input} />
        </label>
        <label style={col}>
          <span style={lbl}>URL（拡張子で形式検証）</span>
          <input data-testid="asset-url" value={url} onChange={(e) => setUrl(e.target.value)} style={{ ...input, minWidth: 260 }} />
        </label>
        <button type="button" data-testid="asset-add" onClick={add} disabled={busy} style={primary}>登録</button>
      </div>
      {error ? <p data-testid="asset-error" style={{ color: 'var(--color-danger)' }}>{error}</p> : null}

      <table data-testid="asset-table" style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.2)' }}>
            <th style={cell}>種別</th>
            <th style={cell}>名称</th>
            <th style={cell}>状態</th>
            <th style={cell}>適用</th>
            <th style={cell}>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id} data-testid="asset-row" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              <td style={cell}>{KIND_LABEL[a.kind]}</td>
              <td style={cell} data-testid="asset-name-cell">{a.name}</td>
              <td style={{ ...cell, color: a.enabled ? 'var(--color-success)' : 'var(--color-muted)' }}>{a.enabled ? '有効' : '無効'}</td>
              <td style={cell}>{active[a.kind] === a.id ? <strong data-testid="asset-active">適用中</strong> : '-'}</td>
              <td style={cell}>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" data-testid="asset-activate" onClick={() => patch(a.id, { active: true })} disabled={!a.enabled} style={small}>適用</button>
                  <button type="button" data-testid="asset-toggle" onClick={() => patch(a.id, { enabled: !a.enabled })} style={small}>{a.enabled ? '無効化' : '有効化'}</button>
                </div>
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
const input: React.CSSProperties = {
  minHeight: 40, padding: '8px 12px', borderRadius: 8,
  border: '1px solid var(--color-surface-2)', background: 'var(--color-surface)', color: 'var(--color-text)',
};
const primary: React.CSSProperties = {
  minHeight: 40, padding: '8px 16px', borderRadius: 8, border: 'none',
  background: 'var(--color-accent)', color: '#0f172a', fontWeight: 700, cursor: 'pointer',
};
const small: React.CSSProperties = {
  padding: '6px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.2)',
  background: 'var(--color-surface)', color: 'var(--color-text)', cursor: 'pointer',
};
const cell: React.CSSProperties = { padding: '8px 12px' };
