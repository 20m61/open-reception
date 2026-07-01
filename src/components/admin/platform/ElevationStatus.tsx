'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  buildElevateRequest,
  elevateErrorMessage,
  elevationScopeLabel,
  formatRemaining,
  type ElevationView,
} from '@/lib/platform/client-elevation';

/**
 * JIT 昇格の状態表示 + 開始/終了 UI (issue #83 §2 / inc4d)。
 *
 * platform 全ページ共通（layout 直下）に現在の昇格状態を常時明示する:
 *   - 非昇格: 「読み取り専用」。理由 + 再認証コード（mock、実 MFA は #65）で
 *     `POST /api/platform/elevate` を呼び、昇格を開始できる。
 *   - 昇格中: 残り時間（毎秒更新）・対象スコープ・入力した理由を表示し、
 *     「昇格を終了」で `POST /api/platform/elevate/end`（jti 即時失効）を呼べる。
 *
 * セキュリティ: **サーバ強制（assertElevated / 署名 cookie / jti 失効ストア）が本体**であり、
 * この UI は可視化と導線の UX に過ぎない。ここでの表示・カウントダウンに依存した保護はしない
 * （表示が「昇格中」でもサーバが失効していれば write は 403 になる）。initial は SSR 時点の
 * スナップショットで、cookie 平文や secret はクライアントに渡さない。
 */
export function ElevationStatus({ initial }: { initial: ElevationView | null }) {
  const [elevation, setElevation] = useState<ElevationView | null>(initial);
  const [now, setNow] = useState(() => Date.now());
  const [formOpen, setFormOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [credential, setCredential] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const active = elevation !== null && elevation.until > now;
  // 期限到達は elevation を消さず「active でない」として導出する（表示は自動で読み取り専用へ戻る）。
  const autoExpired = elevation !== null && !active;

  // 昇格中は残り時間を毎秒更新。until を過ぎると active が偽になり、自動失効表示に切り替わる（#83）。
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  async function submitElevate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    const built = buildElevateRequest({ reason, credential });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/platform/elevate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(built.payload),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setError(elevateErrorMessage(res.status, body));
        return;
      }
      const until = (body as { until?: unknown } | null)?.until;
      setElevation({
        until: typeof until === 'number' ? until : Date.now(),
        scope: {}, // inc4b の発行はプラットフォーム全体スコープ固定（テナント限定昇格は後続増分）。
        reason: built.payload.reason,
      });
      setNow(Date.now());
      setFormOpen(false);
      setReason('');
      setCredential('');
    } catch {
      setError('昇格リクエストの送信に失敗しました。ネットワークを確認してください。');
    } finally {
      setBusy(false);
    }
  }

  async function endElevation() {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      // end は冪等（cookie 無し/失効済みでも 200）。応答を待ってから表示を戻す。
      const res = await fetch('/api/platform/elevate/end', { method: 'POST' });
      if (!res.ok) {
        setError(`昇格の終了に失敗しました（HTTP ${res.status}）。`);
        return;
      }
      setElevation(null);
      setInfo('昇格を終了しました（読み取り専用に戻りました）。');
    } catch {
      setError('昇格終了リクエストの送信に失敗しました。');
    } finally {
      setBusy(false);
    }
  }

  const inputStyle = {
    background: 'var(--color-surface-2)',
    border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: 8,
    padding: '6px 10px',
    color: 'inherit',
    fontSize: '0.85rem',
  } as const;

  return (
    <section
      id="platform-elevation"
      aria-label="JIT 昇格の状態"
      data-testid="elevation-status"
      style={{
        border: active ? '1px solid rgba(224,168,128,0.6)' : '1px solid rgba(255,255,255,0.12)',
        background: active ? 'rgba(224,168,128,0.08)' : 'var(--color-surface)',
        borderRadius: 12,
        padding: 'var(--space-md)',
        marginBottom: 'var(--space-lg)',
        fontSize: '0.85rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
        <strong style={{ color: active ? '#e0a880' : undefined }}>
          {active ? 'JIT 昇格中' : 'JIT 昇格: なし（読み取り専用）'}
        </strong>
        {active && elevation ? (
          <>
            <span data-testid="elevation-remaining">
              {/* SSR 時点と hydration 時点で now が進み文字列が変わり得るため、時刻表示のみ許容する。 */}
              残り <strong suppressHydrationWarning>{formatRemaining(elevation.until, now)}</strong>
            </span>
            <span style={{ opacity: 0.8 }}>対象: {elevationScopeLabel(elevation.scope)}</span>
            {elevation.reason ? <span style={{ opacity: 0.65 }}>理由: {elevation.reason}</span> : null}
            <button
              type="button"
              onClick={() => void endElevation()}
              disabled={busy}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              昇格を終了
            </button>
          </>
        ) : (
          <>
            <span style={{ opacity: 0.7 }}>
              破壊的操作（登録・変更・失効）には理由と再認証を伴う一時昇格が必要です（既定 30 分で自動失効）。
            </span>
            {!formOpen ? (
              <button
                type="button"
                onClick={() => setFormOpen(true)}
                style={{ ...inputStyle, cursor: 'pointer' }}
              >
                昇格を開始…
              </button>
            ) : null}
          </>
        )}
      </div>

      {!active && formOpen ? (
        <form
          onSubmit={(e) => void submitElevate(e)}
          style={{
            display: 'flex',
            gap: 'var(--space-sm)',
            flexWrap: 'wrap',
            alignItems: 'center',
            marginTop: 'var(--space-sm)',
          }}
        >
          <span style={{ opacity: 0.8 }}>対象: プラットフォーム全体</span>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="操作理由（必須・監査に記録）"
            aria-label="操作理由"
            style={{ ...inputStyle, minWidth: 220 }}
          />
          {/* 再認証コード: mock（PLATFORM_REAUTH_MOCK）先行。実 MFA(TOTP) は #65。値は送信のみで保持しない。 */}
          <input
            type="password"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            placeholder="再認証コード"
            aria-label="再認証コード"
            autoComplete="one-time-code"
            style={{ ...inputStyle, minWidth: 140 }}
          />
          <button type="submit" disabled={busy} style={{ ...inputStyle, cursor: 'pointer' }}>
            {busy ? '昇格中…' : '昇格する'}
          </button>
          <button
            type="button"
            onClick={() => {
              setFormOpen(false);
              setError(null);
            }}
            style={{ ...inputStyle, cursor: 'pointer', opacity: 0.7 }}
          >
            取消
          </button>
        </form>
      ) : null}

      {error ? (
        <p role="alert" style={{ color: '#e0a880', margin: 'var(--space-sm) 0 0' }}>
          {error}
        </p>
      ) : null}
      {autoExpired ? (
        <p style={{ opacity: 0.7, margin: 'var(--space-sm) 0 0' }}>
          昇格は期限切れで自動失効しました（読み取り専用に戻りました）。
        </p>
      ) : null}
      {info ? <p style={{ opacity: 0.7, margin: 'var(--space-sm) 0 0' }}>{info}</p> : null}
    </section>
  );
}
