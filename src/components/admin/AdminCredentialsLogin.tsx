'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * ユーザー名＋パスワードによる管理ログインフォーム (issue #238)。
 * provider=cognito のとき使う。Cognito の Hosted UI には飛ばさず、この自前フォームから
 * `/api/admin/login` に投げ、サーバが SRP で Cognito 認証する（PW は Cognito へ平文送信しない）。
 */
export function AdminCredentialsLogin() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        router.push('/admin');
        router.refresh();
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: '0.85rem', opacity: 0.8 }}>ユーザー名</span>
        <input
          type="text"
          autoComplete="username"
          data-testid="admin-username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          style={inputStyle}
        />
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: '0.85rem', opacity: 0.8 }}>パスワード</span>
        <span style={{ position: 'relative', display: 'block' }}>
          <input
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            data-testid="admin-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ ...inputStyle, padding: '8px 48px 8px 12px' }}
          />
          <button
            type="button"
            data-testid="admin-password-toggle"
            aria-label={showPassword ? 'パスワードを隠す' : 'パスワードを表示'}
            onClick={() => setShowPassword((v) => !v)}
            style={{
              position: 'absolute',
              right: 6,
              top: '50%',
              transform: 'translateY(-50%)',
              minWidth: 36,
              minHeight: 36,
              border: 'none',
              background: 'transparent',
              color: 'var(--color-text)',
              cursor: 'pointer',
            }}
          >
            {showPassword ? '🙈' : '👁'}
          </button>
        </span>
      </label>
      {error ? (
        <p data-testid="admin-login-error" className="notice notice--danger" style={{ padding: 12, margin: 0 }}>
          ユーザー名またはパスワードが正しくありません。
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
          cursor: busy ? 'default' : 'pointer',
          opacity: busy ? 0.7 : 1,
        }}
      >
        ログイン
      </button>
    </form>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 44,
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--color-surface-2)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
};
