'use client';

import { useState } from 'react';

type Summary = { mode: string; created: number; updated: number; invalid: Array<{ row: number; reason: string }> };

/** CSV インポート UI (issue #25, #26)。プレビューで差分件数を確認してから取り込む。 */
export function CsvImport({
  endpoint,
  placeholder,
  onApplied,
  testId,
}: {
  endpoint: string;
  placeholder: string;
  onApplied: () => void;
  testId: string;
}) {
  const [csv, setCsv] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (mode: 'preview' | 'apply') => {
    if (csv.trim() === '' || busy) return;
    setBusy(true);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ csv, mode }),
      });
      if (res.ok) {
        setSummary((await res.json()) as Summary);
        if (mode === 'apply') onApplied();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <details style={{ marginBottom: 24 }} data-testid={`${testId}-csv`}>
      <summary style={{ cursor: 'pointer', fontWeight: 700 }}>CSV インポート</summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
        <textarea
          data-testid={`${testId}-csv-input`}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder={placeholder}
          rows={6}
          style={{
            fontFamily: 'monospace',
            padding: 12,
            borderRadius: 8,
            border: '1px solid var(--color-surface-2)',
            background: 'var(--color-surface)',
            color: 'var(--color-text)',
          }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" data-testid={`${testId}-csv-preview`} onClick={() => run('preview')} disabled={busy} style={ghost}>
            プレビュー
          </button>
          <button type="button" data-testid={`${testId}-csv-apply`} onClick={() => run('apply')} disabled={busy} style={primary}>
            取り込む
          </button>
        </div>
        {summary ? (
          <p data-testid={`${testId}-csv-summary`} style={{ margin: 0 }}>
            {summary.mode === 'preview' ? 'プレビュー: ' : '取り込み完了: '}
            新規 {summary.created} 件 / 更新 {summary.updated} 件
            {summary.invalid.length > 0 ? ` / エラー ${summary.invalid.length} 件` : ''}
          </p>
        ) : null}
      </div>
    </details>
  );
}

const ghost: React.CSSProperties = {
  minHeight: 40,
  padding: '6px 14px',
  borderRadius: 8,
  border: '1px solid var(--color-border-strong)',
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  cursor: 'pointer',
};
const primary: React.CSSProperties = {
  minHeight: 40,
  padding: '6px 14px',
  borderRadius: 8,
  border: 'none',
  background: 'var(--color-accent)',
  color: 'var(--color-bg-2)',
  fontWeight: 700,
  cursor: 'pointer',
};
