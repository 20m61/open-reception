'use client';

import { useCallback, useEffect, useState } from 'react';

type SecurityView = { pinRequired: boolean; ipAllowlist: string[]; pinConfigured: boolean };

/** セキュリティ設定 (issue #23, #29)。PIN 必須・PIN 変更・IP 許可リストを編集する。 */
export function SecurityManager() {
  const [view, setView] = useState<SecurityView | null>(null);
  const [pinRequired, setPinRequired] = useState(false);
  const [pin, setPin] = useState('');
  const [ipText, setIpText] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/admin/security');
    if (res.ok) {
      const v = (await res.json()) as SecurityView;
      setView(v);
      setPinRequired(v.pinRequired);
      setIpText(v.ipAllowlist.join('\n'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setSaved(false);
    try {
      const ipAllowlist = ipText.split('\n').map((s) => s.trim()).filter(Boolean);
      const body: Record<string, unknown> = { pinRequired, ipAllowlist };
      if (pin.trim() !== '') body.pin = pin.trim();
      const res = await fetch('/api/admin/security', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setPin('');
        setSaved(true);
        await load();
      }
    } finally {
      setBusy(false);
    }
  }, [busy, ipText, pinRequired, pin, load]);

  if (!view) return <section><h1 style={{ marginTop: 0 }}>セキュリティ設定</h1><p>読み込み中…</p></section>;

  return (
    <section style={{ maxWidth: 480 }}>
      <h1 style={{ marginTop: 0 }}>セキュリティ設定</h1>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            data-testid="security-pin-required"
            checked={pinRequired}
            onChange={(e) => setPinRequired(e.target.checked)}
          />
          受付端末の表示に PIN 許可を必須にする
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: '0.85rem', opacity: 0.8 }}>
            PIN を変更（空欄なら変更しない／現在: {view.pinConfigured ? '設定済み' : '未設定'}）
          </span>
          <input type="password" data-testid="security-pin" value={pin} onChange={(e) => setPin(e.target.value)} style={input} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: '0.85rem', opacity: 0.8 }}>IP 許可リスト（1 行に 1 件、空なら全許可）</span>
          <textarea data-testid="security-ip" value={ipText} onChange={(e) => setIpText(e.target.value)} rows={4} style={input} />
        </label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" data-testid="security-save" onClick={save} disabled={busy} style={primary}>
            保存
          </button>
          {saved ? <span data-testid="security-saved" style={{ color: 'var(--color-success)' }}>保存しました</span> : null}
        </div>
      </div>
    </section>
  );
}

const input: React.CSSProperties = {
  minHeight: 40,
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--color-surface-2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
};
const primary: React.CSSProperties = {
  minHeight: 40,
  padding: '8px 16px',
  borderRadius: 8,
  border: 'none',
  background: 'var(--color-accent)',
  color: '#0f172a',
  fontWeight: 700,
  cursor: 'pointer',
};
