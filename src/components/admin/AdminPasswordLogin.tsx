'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** パスワードによる管理ログインフォーム (issue #24)。検証は server 側で行う。 */
export function AdminPasswordLogin() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.push('/admin');
        router.refresh();
      } else {
        setError(true);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: '0.85rem', opacity: 0.8 }}>パスワード</span>
        <input
          type="password"
          data-testid="admin-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{
            minHeight: 44,
            padding: '8px 12px',
            borderRadius: 8,
            border: '1px solid var(--color-surface-2)',
            background: 'var(--color-surface)',
            color: 'var(--color-text)',
          }}
        />
      </label>
      {error ? (
        <p data-testid="admin-login-error" style={{ color: 'var(--color-danger)', margin: 0 }}>
          パスワードが正しくありません。
        </p>
      ) : null}
      <button
        type="submit"
        data-testid="admin-login-submit"
        disabled={busy}
        style={{
          minHeight: 44,
          borderRadius: 8,
          border: 'none',
          background: 'var(--color-accent)',
          color: '#0f172a',
          fontWeight: 700,
          cursor: 'pointer',
        }}
      >
        ログイン
      </button>
    </form>
  );
}
