'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Kiosk } from '@/domain/kiosk/types';

/**
 * 受付端末管理（旧レジストリ・issue #18）。登録・失効・再有効化を管理 API 経由で行う。
 *
 * Kiosk→Device 統合 (issue #87)：テナント/サイト境界つきの受付端末管理は `/admin/devices`
 * に集約していく方針（docs/site-device-management-design.md §Device/Kiosk 統合）。この画面は
 * 当面の互換のため残す（kiosk token 登録・失効など旧フローの維持）。重複説明を避けるため、
 * 上部に統合先への導線を出す。
 */
export function KiosksManager() {
  const [items, setItems] = useState<Kiosk[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [location, setLocation] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/kiosks');
    if (res.ok) setItems(((await res.json()) as { items: Kiosk[] }).items);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = useCallback(async () => {
    if (displayName.trim() === '' || busy) return;
    setBusy(true);
    try {
      await fetch('/api/admin/kiosks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName, location: location || undefined }),
      });
      setDisplayName('');
      setLocation('');
      await load();
    } finally {
      setBusy(false);
    }
  }, [displayName, location, busy, load]);

  const setEnabled = useCallback(
    async (k: Kiosk, enabled: boolean) => {
      await fetch(`/api/admin/kiosks/${k.id}/${enabled ? 'restore' : 'revoke'}`, { method: 'POST' });
      await load();
    },
    [load],
  );

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>受付端末管理（旧）</h1>

      <p data-testid="kiosk-devices-link" style={noticeStyle}>
        テナント・拠点（サイト）境界つきの受付端末管理は{' '}
        <a href="/admin/devices" style={{ color: 'var(--color-accent)', fontWeight: 700 }}>
          受付端末（/admin/devices）
        </a>{' '}
        に集約しています。オンライン状態・拠点ごとの管理はそちらをご利用ください。この画面は
        従来フロー互換のため残しています。
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 24 }}>
        <label style={col}>
          <span style={lbl}>端末名</span>
          <input data-testid="kiosk-name-input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} style={inputStyle} />
        </label>
        <label style={col}>
          <span style={lbl}>設置場所（任意）</span>
          <input data-testid="kiosk-location-input" value={location} onChange={(e) => setLocation(e.target.value)} style={inputStyle} />
        </label>
        <button type="button" data-testid="kiosk-add" onClick={add} disabled={busy || displayName.trim() === ''} style={btnStyle}>
          登録
        </button>
      </div>

      <table data-testid="kiosk-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border-strong)' }}>
            <th style={cell}>端末名</th>
            <th style={cell}>設置場所</th>
            <th style={cell}>状態</th>
            <th style={cell}>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((k) => (
            <tr key={k.id} data-testid="kiosk-row" style={{ borderBottom: '1px solid var(--color-border)' }}>
              <td style={cell} data-testid="kiosk-name">
                {k.displayName}
              </td>
              <td style={cell}>{k.location ?? '-'}</td>
              <td style={{ ...cell, color: k.enabled ? 'var(--color-success)' : 'var(--color-danger)' }}>
                {k.enabled ? '有効' : '失効'}
              </td>
              <td style={cell}>
                <button type="button" data-testid="kiosk-toggle" onClick={() => setEnabled(k, !k.enabled)} style={smallBtn}>
                  {k.enabled ? '失効する' : '再有効化'}
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
const noticeStyle: React.CSSProperties = {
  margin: '0 0 24px',
  padding: '12px 16px',
  borderRadius: 8,
  border: '1px solid var(--color-surface-2)',
  background: 'var(--color-surface)',
  fontSize: '0.9rem',
  lineHeight: 1.6,
};
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
  color: 'var(--color-bg-2)',
  fontWeight: 700,
  cursor: 'pointer',
};
const smallBtn: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: 8,
  border: '1px solid var(--color-border-strong)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  cursor: 'pointer',
};
const cell: React.CSSProperties = { padding: '8px 12px' };
