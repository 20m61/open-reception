'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  CHECKOUT_FAILURE_MESSAGE,
  type CheckoutFlowState,
  type PresentStaySummary,
} from './logic';

/**
 * 受付端末の退館チェックアウトフロー (issue #102, increment 1)。
 *
 * KioskFlow には組み込まない**スタンドアロン**の退館導線（/kiosk/checkout）。
 *   1. 在館中一覧から選ぶ、または受付番号を入力する。
 *   2. 退館を確定する（/api/kiosk/checkout、kiosk セッション保護）。
 *   3. 完了画面は「退館を受け付けました」のみ表示し、個人情報を残さない。
 *      一定時間で入力画面へ自動リセットする（次の来訪者に情報を残さない）。
 *
 * 一覧・完了とも PII を表示しない（受付番号と入館時刻のみ）。
 */

/** 完了画面の自動リセット時間（ミリ秒）。 */
const RESET_DELAY_MS = 5000;

export function CheckoutFlow() {
  const [state, setState] = useState<CheckoutFlowState>('input');
  const [stayId, setStayId] = useState('');
  const [present, setPresent] = useState<PresentStaySummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadPresent = useCallback(async () => {
    try {
      const res = await fetch('/api/kiosk/checkout');
      if (res.ok) {
        const data = (await res.json()) as { stays: PresentStaySummary[] };
        setPresent(data.stays);
      }
    } catch {
      // 一覧取得失敗は致命的でない（手入力で退館できる）。
    }
  }, []);

  useEffect(() => {
    void loadPresent();
  }, [loadPresent]);

  // 完了後に入力画面へ自動で戻す（PII を残さない）。
  useEffect(() => {
    if (state !== 'done') return;
    const timer = setTimeout(() => {
      setState('input');
      setStayId('');
      setError(null);
      void loadPresent();
    }, RESET_DELAY_MS);
    return () => clearTimeout(timer);
  }, [state, loadPresent]);

  const checkout = useCallback(
    async (id: string) => {
      const trimmed = id.trim();
      if (trimmed === '' || busy) return;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch('/api/kiosk/checkout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stayId: trimmed }),
        });
        if (res.ok) {
          setState('done');
        } else {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          setError(CHECKOUT_FAILURE_MESSAGE(data?.error));
        }
      } catch {
        setError(CHECKOUT_FAILURE_MESSAGE('network'));
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  if (state === 'done') {
    return (
      <main style={pageStyle} data-testid="checkout-done">
        <div style={cardStyle}>
          <h1 style={{ margin: 0 }}>退館を受け付けました</h1>
          <p style={{ opacity: 0.8 }}>お気をつけてお帰りください。</p>
        </div>
      </main>
    );
  }

  return (
    <main style={pageStyle}>
      <div style={cardStyle}>
        <h1 style={{ marginTop: 0 }}>退館チェックアウト</h1>
        <p style={{ opacity: 0.8, marginTop: 0 }}>
          受付番号を入力するか、在館中の一覧から選んで退館してください。
        </p>

        <label htmlFor="checkout-stay-id" style={labelStyle}>
          受付番号
        </label>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <input
            id="checkout-stay-id"
            data-testid="checkout-stay-id"
            value={stayId}
            onChange={(e) => setStayId(e.target.value)}
            placeholder="stay-..."
            style={inputStyle}
          />
          <button
            type="button"
            data-testid="checkout-submit"
            onClick={() => void checkout(stayId)}
            disabled={busy || stayId.trim() === ''}
            style={primaryButtonStyle}
          >
            退館する
          </button>
        </div>

        {error ? (
          <p data-testid="checkout-error" role="alert" style={{ color: '#f87171' }}>
            {error}
          </p>
        ) : null}

        <h2 style={{ fontSize: '1.1rem', marginBottom: 8 }}>在館中の来訪者</h2>
        {present.length === 0 ? (
          <p data-testid="checkout-empty" style={{ opacity: 0.7 }}>
            在館中の来訪者はいません。
          </p>
        ) : (
          <ul data-testid="checkout-present-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {present.map((s) => (
              <li key={s.stayId} style={listItemStyle}>
                <span>
                  <code style={{ fontSize: '0.85rem' }}>{s.stayId}</code>
                  <span style={{ opacity: 0.7, marginLeft: 12 }}>{formatTime(s.checkedInAt)} 入館</span>
                </span>
                <button
                  type="button"
                  data-testid="checkout-present-item"
                  onClick={() => void checkout(s.stayId)}
                  disabled={busy}
                  style={secondaryButtonStyle}
                >
                  退館
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

function formatTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  background: '#0f172a',
  color: '#e2e8f0',
};

const cardStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: 560,
  background: '#1e293b',
  borderRadius: 16,
  padding: 32,
  boxShadow: '0 10px 40px rgba(0,0,0,0.4)',
};

const labelStyle: React.CSSProperties = { display: 'block', marginBottom: 8, fontWeight: 700 };

const inputStyle: React.CSSProperties = {
  flex: '1 1 240px',
  minHeight: 48,
  padding: '12px 16px',
  fontSize: '1.1rem',
  borderRadius: 10,
  border: '1px solid #334155',
  background: '#0f172a',
  color: '#e2e8f0',
};

const primaryButtonStyle: React.CSSProperties = {
  minHeight: 48,
  padding: '12px 24px',
  fontSize: '1.1rem',
  fontWeight: 700,
  borderRadius: 10,
  border: 'none',
  background: '#38bdf8',
  color: '#0f172a',
  cursor: 'pointer',
};

const secondaryButtonStyle: React.CSSProperties = {
  minHeight: 40,
  padding: '8px 18px',
  fontWeight: 700,
  borderRadius: 8,
  border: '1px solid #38bdf8',
  background: 'transparent',
  color: '#38bdf8',
  cursor: 'pointer',
};

const listItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '12px 0',
  borderBottom: '1px solid #334155',
};
