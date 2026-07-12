'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  buildBreakGlassRequest,
  buildElevateRequest,
  breakGlassErrorMessage,
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
 * break-glass（緊急権限, #83 §3）は通常導線に出さない: 平常時は目立たない「緊急アクセス」
 * エントリのみを置き、開いても**緊急事態確認（解錠チェック）**を通すまで発行フォームを有効化しない。
 * 発行は別エンドポイント（/api/platform/elevate/break-glass）・15 分固定窓・高重要度監査で、
 * 利用中は明示の警告表示（全操作が記録され利用後レビュー対象であること）を出す。
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
  // break-glass（#83 §3）: 平常時はロックされた「緊急アクセス」導線のみ。acknowledged が解錠ステップ。
  const [bgOpen, setBgOpen] = useState(false);
  const [bgAcknowledged, setBgAcknowledged] = useState(false);

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

  async function submitBreakGlass(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    const built = buildBreakGlassRequest({ reason, credential, acknowledged: bgAcknowledged });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/platform/elevate/break-glass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(built.payload),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setError(breakGlassErrorMessage(res.status, body));
        return;
      }
      const until = (body as { until?: unknown } | null)?.until;
      setElevation({
        until: typeof until === 'number' ? until : Date.now(),
        scope: {}, // break-glass は緊急対応のため platform 全体スコープ（サーバ側で固定）。
        reason: built.payload.reason,
        breakGlass: true,
      });
      setNow(Date.now());
      setBgOpen(false);
      setBgAcknowledged(false);
      setReason('');
      setCredential('');
    } catch {
      setError('break-glass リクエストの送信に失敗しました。ネットワークを確認してください。');
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
    border: '1px solid var(--color-border-strong)',
    borderRadius: 8,
    padding: '6px 10px',
    color: 'inherit',
    fontSize: '0.85rem',
  } as const;

  // break-glass 昇格中は通常昇格より強い警告色で常時明示する（#83 §3）。
  const activeBreakGlass = active && elevation?.breakGlass === true;

  return (
    <section
      id="platform-elevation"
      aria-label="JIT 昇格の状態"
      data-testid="elevation-status"
      style={{
        border: activeBreakGlass
          ? '1px solid color-mix(in srgb, var(--color-platform-danger) 75%, transparent)'
          : active
            ? '1px solid color-mix(in srgb, var(--color-platform-warn) 60%, transparent)'
            : '1px solid var(--color-border-strong)',
        background: activeBreakGlass
          ? 'color-mix(in srgb, var(--color-platform-danger) 10%, transparent)'
          : active
            ? 'color-mix(in srgb, var(--color-platform-warn) 8%, transparent)'
            : 'var(--color-surface)',
        borderRadius: 12,
        padding: 'var(--space-md)',
        marginBottom: 'var(--space-lg)',
        fontSize: '0.85rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
        <strong style={{ color: activeBreakGlass ? 'var(--color-platform-danger)' : active ? 'var(--color-platform-warn)' : undefined }}>
          {activeBreakGlass
            ? 'BREAK-GLASS 昇格中（緊急）'
            : active
              ? 'JIT 昇格中'
              : 'JIT 昇格: なし（読み取り専用）'}
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
            {!formOpen && !bgOpen ? (
              <>
                <button
                  type="button"
                  onClick={() => setFormOpen(true)}
                  style={{ ...inputStyle, cursor: 'pointer' }}
                >
                  昇格を開始…
                </button>
                {/* break-glass は通常導線に混ぜず、平常時はロックされた低強調エントリのみ（#83 §3）。 */}
                <button
                  type="button"
                  data-testid="break-glass-entry"
                  onClick={() => {
                    setBgOpen(true);
                    setBgAcknowledged(false);
                    setError(null);
                  }}
                  style={{ ...inputStyle, cursor: 'pointer', opacity: 0.45 }}
                  title="障害対応など緊急時のみ。解錠と理由・再認証が必要です。"
                >
                  緊急アクセス（break-glass）…
                </button>
              </>
            ) : null}
          </>
        )}
      </div>

      {active && elevation ? (
        activeBreakGlass ? (
          <p style={{ color: 'var(--color-platform-danger)', margin: 'var(--space-sm) 0 0' }}>
            緊急権限で操作しています。この間のすべての操作は高重要度監査に記録され、利用後レビューの
            対象です（15 分で自動失効・不要になったら直ちに終了してください）。
          </p>
        ) : null
      ) : null}

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

      {!active && bgOpen ? (
        <form
          onSubmit={(e) => void submitBreakGlass(e)}
          data-testid="break-glass-panel"
          style={{
            border: '1px solid color-mix(in srgb, var(--color-platform-danger) 50%, transparent)',
            background: 'color-mix(in srgb, var(--color-platform-danger) 6%, transparent)',
            borderRadius: 8,
            padding: 'var(--space-md)',
            marginTop: 'var(--space-sm)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-sm)',
          }}
        >
          <strong style={{ color: 'var(--color-platform-danger)' }}>break-glass（緊急権限）— 障害時のみ</strong>
          <p style={{ margin: 0, opacity: 0.8 }}>
            通常の JIT 昇格と分離された緊急経路です。窓は 15 分固定・すべての操作が高重要度監査に
            記録され、利用後レビューの対象になります。平常時の作業には通常の「昇格を開始」を使ってください。
          </p>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={bgAcknowledged}
              onChange={(e) => setBgAcknowledged(e.target.checked)}
              aria-label="緊急事態であることを確認"
            />
            <span>緊急事態（障害対応等）であり、記録・レビュー対象になることを確認しました。</span>
          </label>
          {/* 解錠（確認チェック）まで入力・送信をロックする（#83 §3「非表示またはロック + 明示的な解錠」）。 */}
          <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="緊急対応の理由（必須・高重要度監査に記録）"
              aria-label="緊急対応の理由"
              disabled={!bgAcknowledged}
              style={{ ...inputStyle, minWidth: 260, opacity: bgAcknowledged ? 1 : 0.5 }}
            />
            <input
              type="password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              placeholder="再認証コード"
              aria-label="再認証コード"
              autoComplete="one-time-code"
              disabled={!bgAcknowledged}
              style={{ ...inputStyle, minWidth: 140, opacity: bgAcknowledged ? 1 : 0.5 }}
            />
            <button
              type="submit"
              disabled={busy || !bgAcknowledged}
              style={{ ...inputStyle, cursor: 'pointer', borderColor: 'color-mix(in srgb, var(--color-platform-danger) 60%, transparent)' }}
            >
              {busy ? '発行中…' : '緊急権限を発行する'}
            </button>
            <button
              type="button"
              onClick={() => {
                setBgOpen(false);
                setBgAcknowledged(false);
                setError(null);
              }}
              style={{ ...inputStyle, cursor: 'pointer', opacity: 0.7 }}
            >
              取消
            </button>
          </div>
        </form>
      ) : null}

      {error ? (
        <p role="alert" style={{ color: 'var(--color-platform-warn)', margin: 'var(--space-sm) 0 0' }}>
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
