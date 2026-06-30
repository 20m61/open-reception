'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { tokenFromUrl } from './token-from-url';

/**
 * 受付端末エンロール画面 (docs/reception-issuance-design.md inc1)。
 *
 * 管理画面が発行した受付URL/QR（`/kiosk/enroll#token=…`）で開かれる。token を
 * `/api/kiosk/enroll` に渡して kiosk セッションへ交換し、成功したら受付画面 `/kiosk` へ遷移する。
 * 成功後は token を URL から消すため replace で遷移する。token は表示・ログに残さない。
 *
 * トークンは **fragment**（`#token=…`）で受け取る (issue #239)。fragment はサーバへ送られず
 * アクセスログに残らないため、クエリ露出を避ける。旧 URL 互換で query もフォールバックで読む。
 */
type Phase =
  | { kind: 'working' }
  | { kind: 'error'; title: string; detail: string; retryable: boolean };

/**
 * `retryable`: 同じ URL の再試行で復帰しうるか。トークンが無効/使用済み等の端末エラーは
 * 何度叩いても直らないため false（再試行ボタンを出さず「管理画面で再発行」を案内）。通信エラー
 * のみ true（一時的なため再試行が有効）。
 */
type ErrorCopy = { title: string; detail: string; retryable: boolean };

const FALLBACK_ERROR: ErrorCopy = {
  title: 'URLが無効か期限切れです',
  detail: '管理画面で受付URLを再発行してください。',
  retryable: false,
};

/** API のエラーコード → 受付端末向けの平易なメッセージ。 */
const ERROR_MESSAGE: Record<string, ErrorCopy> = {
  missing: {
    title: 'URLが不正です',
    detail: 'QRコードまたはURLをもう一度確認してください。',
    retryable: false,
  },
  invalid_token: FALLBACK_ERROR,
  used: {
    title: 'このURLは既に使用されています',
    detail: '管理画面で受付URLを再発行してください。',
    retryable: false,
  },
  not_found: {
    title: '端末が見つかりません',
    detail: '管理画面で端末の登録を確認してください。',
    retryable: false,
  },
  revoked: {
    title: 'この端末は無効化されています',
    detail: '管理画面で端末を有効化してから再発行してください。',
    retryable: false,
  },
  network: {
    title: '通信に失敗しました',
    detail: 'ネットワークを確認して、もう一度お試しください。',
    retryable: true,
  },
};

function toError(code: string): Phase {
  const m = ERROR_MESSAGE[code] ?? FALLBACK_ERROR;
  return { kind: 'error', title: m.title, detail: m.detail, retryable: m.retryable };
}

export default function KioskEnrollPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'working' });

  const enroll = useCallback(async () => {
    setPhase({ kind: 'working' });
    // 既にエンロール済み（kiosk セッション保持）なら、使い捨てトークンを再消費せず受付画面へ。
    // これがないと、URL をホーム画面ブックマークした端末が再起動のたびに consume 済みトークンを
    // 叩いて 409 'used' で締め出される。
    try {
      const status = await fetch('/api/kiosk/session-status', { cache: 'no-store' });
      if (status.ok && ((await status.json()) as { authorized?: boolean }).authorized) {
        router.replace('/kiosk');
        return;
      }
    } catch {
      // セッション確認に失敗しても通常のエンロールへフォールスルー。
    }

    // useSearchParams は Suspense 境界を要するため、ここでは location から直接読む。
    // fragment 優先・query フォールバック (issue #239)。
    const token = tokenFromUrl({ hash: window.location.hash, search: window.location.search });
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
        <div
          data-testid="enroll-error"
          style={{ maxWidth: 480, display: 'grid', gap: 'var(--space-md)', wordBreak: 'keep-all' }}
        >
          <h1 style={{ fontSize: '1.6rem', margin: 0 }}>{phase.title}</h1>
          <p style={{ opacity: 0.85, margin: 0 }}>{phase.detail}</p>
          {phase.retryable ? (
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
          ) : null}
        </div>
      )}
    </main>
  );
}
