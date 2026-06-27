'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 受付端末エンロール画面 (docs/reception-issuance-design.md inc1)。
 *
 * 管理画面が発行した受付URL/QR（`/kiosk/enroll?token=…`）で開かれる。token を
 * `/api/kiosk/enroll` に渡して kiosk セッションへ交換し、成功したら受付画面 `/kiosk` へ遷移する。
 * 成功後は token を URL から消すため replace で遷移する。token は表示・ログに残さない。
 */
type Phase =
  | { kind: 'working' }
  | { kind: 'error'; title: string; detail: string };

type ErrorCopy = { title: string; detail: string };

const FALLBACK_ERROR: ErrorCopy = {
  title: 'URLが無効か期限切れです',
  detail: '管理画面で受付URLを再発行してください。',
};

/** API のエラーコード → 受付端末向けの平易なメッセージ。 */
const ERROR_MESSAGE: Record<string, ErrorCopy> = {
  missing: {
    title: 'URLが不正です',
    detail: 'QRコードまたはURLをもう一度確認してください。',
  },
  invalid_token: FALLBACK_ERROR,
  used: {
    title: 'このURLは既に使用されています',
    detail: '管理画面で受付URLを再発行してください。',
  },
  not_found: {
    title: '端末が見つかりません',
    detail: '管理画面で端末の登録を確認してください。',
  },
  revoked: {
    title: 'この端末は無効化されています',
    detail: '管理画面で端末を有効化してから再発行してください。',
  },
  network: {
    title: '通信に失敗しました',
    detail: 'ネットワークを確認して、もう一度お試しください。',
  },
};

function toError(code: string): Phase {
  const m = ERROR_MESSAGE[code] ?? FALLBACK_ERROR;
  return { kind: 'error', title: m.title, detail: m.detail };
}

export default function KioskEnrollPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'working' });

  const enroll = useCallback(async () => {
    setPhase({ kind: 'working' });
    // useSearchParams は Suspense 境界を要するため、ここでは location から直接読む。
    const token = new URLSearchParams(window.location.search).get('token') ?? '';
    if (!token) {
      setPhase(toError('missing'));
      return;
    }
    try {
      const res = await fetch('/api/kiosk/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        router.replace('/kiosk');
        return;
      }
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      setPhase(toError(data?.error ?? 'invalid_token'));
    } catch {
      setPhase(toError('network'));
    }
  }, [router]);

  useEffect(() => {
    void enroll();
  }, [enroll]);

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-lg)',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-lg)',
        textAlign: 'center',
      }}
    >
      {phase.kind === 'working' ? (
        <p data-testid="enroll-working" style={{ fontSize: '1.25rem', opacity: 0.85 }}>
          受付端末を準備しています…
        </p>
      ) : (
        <div data-testid="enroll-error" style={{ maxWidth: 480, display: 'grid', gap: 'var(--space-md)' }}>
          <h1 style={{ fontSize: '1.6rem', margin: 0 }}>{phase.title}</h1>
          <p style={{ opacity: 0.85, margin: 0 }}>{phase.detail}</p>
          <button
            data-testid="enroll-retry"
            onClick={() => void enroll()}
            style={{
              minHeight: 'var(--touch-target-min)',
              padding: '0 24px',
              borderRadius: 'var(--radius-lg)',
              border: '1px solid rgba(255,255,255,0.2)',
              background: 'var(--color-surface)',
              color: 'var(--color-text)',
              fontWeight: 700,
              fontSize: '1.05rem',
              cursor: 'pointer',
            }}
          >
            再試行
          </button>
        </div>
      )}
    </main>
  );
}
