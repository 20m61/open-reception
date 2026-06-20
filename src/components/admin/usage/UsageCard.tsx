import type { ReactNode } from 'react';

/**
 * 利用量・コストの 1 指標カード (issue #89, increment 1)。
 *
 * #86 の dashboard/MetricCard とは別物（usage 配下に閉じる）。トップレベル共通化は #92。
 * 業務単位の値を大きく見せ、補足（hint）と注記（note）を添える。
 */
export type CardTone = 'neutral' | 'success' | 'warning' | 'danger';

const TONE_COLOR: Record<CardTone, string> = {
  neutral: 'var(--color-text)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  danger: 'var(--color-danger)',
};

export function UsageCard({
  label,
  value,
  unit,
  tone = 'neutral',
  hint,
  note,
  children,
}: {
  label: string;
  value?: ReactNode;
  unit?: string;
  tone?: CardTone;
  hint?: string;
  note?: string;
  children?: ReactNode;
}) {
  return (
    <div
      data-testid="usage-card"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 'var(--space-md, 16px)',
        borderRadius: 12,
        background: 'var(--color-surface)',
        border: '1px solid var(--color-surface-2)',
        minHeight: 110,
        height: '100%',
      }}
    >
      <span style={{ fontSize: '0.85rem', opacity: 0.8 }}>{label}</span>
      {value !== undefined ? (
        <span style={{ fontSize: '1.9rem', fontWeight: 800, color: TONE_COLOR[tone] }}>
          {value}
          {unit ? (
            <span style={{ fontSize: '0.95rem', fontWeight: 600, opacity: 0.7, marginLeft: 4 }}>{unit}</span>
          ) : null}
        </span>
      ) : null}
      {children}
      {hint ? <span style={{ fontSize: '0.8rem', opacity: 0.65 }}>{hint}</span> : null}
      {note ? (
        <span data-testid="usage-note" style={{ fontSize: '0.75rem', opacity: 0.6, fontStyle: 'italic' }}>
          {note}
        </span>
      ) : null}
    </div>
  );
}

/** カードを並べるレスポンシブグリッド。 */
export function CardGrid({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gap: 'var(--space-md, 16px)',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
      }}
    >
      {children}
    </div>
  );
}
