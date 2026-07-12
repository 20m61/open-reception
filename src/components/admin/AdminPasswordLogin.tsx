'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** パスワードによる管理ログインフォーム (issue #24)。検証は server 側で行う。 */
export function AdminPasswordLogin() {
  const router = useRouter();
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
        <span style={{ position: 'relative', display: 'block' }}>
          <input
            type={showPassword ? 'text' : 'password'}
            data-testid="admin-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{
              width: '100%',
              minHeight: 44,
              // 目アイコンのボタン分だけ右パディングを空ける。
              padding: '8px 48px 8px 12px',
              borderRadius: 8,
              border: '1px solid var(--color-surface-2)',
              background: 'var(--color-surface)',
              color: 'var(--color-text)',
            }}
          />
          <button
            type="button"
            data-testid="admin-password-toggle"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? 'パスワードを隠す' : 'パスワードを表示'}
            aria-pressed={showPassword}
            title={showPassword ? 'パスワードを隠す' : 'パスワードを表示'}
            style={{
              position: 'absolute',
              right: 4,
              top: '50%',
              transform: 'translateY(-50%)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 40,
              height: 40,
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: 'var(--color-muted)',
              cursor: 'pointer',
            }}
          >
            {showPassword ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </span>
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
          color: 'var(--color-bg-2)',
          fontWeight: 700,
          cursor: 'pointer',
        }}
      >
        ログイン
      </button>
    </form>
  );
}

/** 表示中（クリックで隠す）を表す目アイコン。 */
function EyeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** 非表示中（クリックで表示）を表す目に斜線のアイコン。 */
function EyeOffIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3.5 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <path d="M14.12 14.12A3 3 0 1 1 9.88 9.88" />
      <path d="m2 2 20 20" />
    </svg>
  );
}
