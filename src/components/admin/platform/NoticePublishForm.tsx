'use client';

import { useState, type FormEvent } from 'react';
import type { NoticeLevel } from '@/domain/platform/notice';
import { buildNoticePublishPayload, noticePublishError } from '@/lib/platform/client-elevation';

/**
 * お知らせ登録フォーム — 昇格つき write の最初の UI 導線 (issue #83 §2 / inc4d)。
 *
 * `POST /api/platform/notices`（inc4c で JIT 昇格ゲート解禁済み）へ、操作理由つきで登録する。
 * 非昇格時はサーバが 403 `elevation_required` を返すため、画面上部の昇格パネル
 * （#platform-elevation）へ誘導する。「無効化プレースホルダ」から「昇格すれば実行できる」への格上げ。
 *
 * セキュリティ: 昇格・監査の強制は**サーバ（handlePlatformDangerCreate: assertElevated +
 * audit-first）が本体**。この UI は入力と誘導の UX のみで、クライアント判定に保護を置かない。
 * 対象スコープは本増分では platform 全体固定（テナント/拠点/端末別のお知らせ UI は後続増分）。
 * title/body/理由に PII・機密値を書かない運用（監査・横断 read に載るため）。
 */
const LEVELS: readonly { value: NoticeLevel; label: string }[] = [
  { value: 'info', label: 'お知らせ' },
  { value: 'warning', label: '注意' },
  { value: 'critical', label: '重要' },
];

export function NoticePublishForm({ onPublished }: { onPublished?: () => void }) {
  const [level, setLevel] = useState<NoticeLevel>('info');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; needsElevation: boolean } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(null);
    const built = buildNoticePublishPayload({ level, title, body, reason });
    if (!built.ok) {
      setError({ message: built.error, needsElevation: false });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/platform/notices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(built.payload),
      });
      const resBody: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setError(noticePublishError(res.status, resBody));
        return;
      }
      setDone(`お知らせ「${built.payload.title}」を掲示しました（監査に記録済み）。`);
      setTitle('');
      setBody('');
      setReason('');
      onPublished?.();
    } catch {
      setError({ message: 'お知らせ登録リクエストの送信に失敗しました。', needsElevation: false });
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
    width: '100%',
    boxSizing: 'border-box',
  } as const;

  return (
    <form
      onSubmit={(e) => void submit(e)}
      data-testid="notice-publish-form"
      style={{
        border: '1px solid color-mix(in srgb, var(--color-platform-warn) 40%, transparent)',
        borderRadius: 10,
        padding: 'var(--space-md)',
        display: 'grid',
        gap: 'var(--space-sm)',
        fontSize: '0.85rem',
      }}
    >
      <strong style={{ color: 'var(--color-platform-warn)' }}>お知らせを登録（昇格が必要な操作）</strong>
      <p style={{ margin: 0, opacity: 0.7 }}>
        全テナントの管理画面に掲示されます（対象: プラットフォーム全体）。実行には JIT
        昇格が必要で、操作理由とともに監査に記録されます。件名・本文に個人情報や機密値を書かないでください。
      </p>
      <div style={{ display: 'flex', gap: 'var(--space-sm)', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          重要度
          <select
            value={level}
            onChange={(e) => setLevel(e.target.value as NoticeLevel)}
            style={{ ...inputStyle, width: 'auto' }}
          >
            {LEVELS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="件名（最大 200 字）"
          aria-label="件名"
          maxLength={200}
          style={{ ...inputStyle, flex: 1, minWidth: 200 }}
        />
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="本文（最大 2000 字）"
        aria-label="本文"
        maxLength={2000}
        rows={3}
        style={inputStyle}
      />
      <input
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="操作理由（必須・監査に記録）"
        aria-label="操作理由"
        style={inputStyle}
      />
      <div>
        <button
          type="submit"
          disabled={busy}
          style={{ ...inputStyle, width: 'auto', cursor: 'pointer' }}
        >
          {busy ? '登録中…' : '昇格つきで登録する'}
        </button>
      </div>

      {error ? (
        <p role="alert" style={{ color: 'var(--color-platform-warn)', margin: 0 }}>
          {error.message}
          {error.needsElevation ? (
            <>
              {' '}
              <a href="#platform-elevation" style={{ color: 'var(--color-platform-warn)', textDecoration: 'underline' }}>
                画面上部の「JIT 昇格」パネルから昇格する
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {done ? <p style={{ color: 'var(--color-platform-ok)', margin: 0 }}>{done}</p> : null}
    </form>
  );
}
