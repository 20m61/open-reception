import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * 概況の 1 指標を表すカード (issue #86, increment 1)。
 * クリックすると詳細画面へ遷移できるカード構成（href 指定時）。
 * 実データが無い指標は `placeholder` を立て、design 注記（note）を添える。
 *
 * dashboard サブディレクトリ内に閉じる（汎用 MetricCard のトップレベル共通化は #92）。
 */
export type MetricTone = 'neutral' | 'success' | 'warning' | 'danger';

const TONE_COLOR: Record<MetricTone, string> = {
  neutral: 'var(--color-text)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  danger: 'var(--color-danger)',
};

export function MetricCard({
  label,
  value,
  unit,
  tone = 'neutral',
  href,
  hint,
  note,
  placeholder = false,
  children,
}: {
  label: string;
  value?: ReactNode;
  unit?: string;
  tone?: MetricTone;
  /** 指定時はカード全体を詳細画面への導線にする。 */
  href?: string;
  /** 補足の一言（業務単位の説明）。 */
  hint?: string;
  /** 実データ未接続時の design 注記。 */
  note?: string;
  /** 実データが無くプレースホルダ表示か。 */
  placeholder?: boolean;
  children?: ReactNode;
}) {
  const body = (
    <div
      data-testid="metric-card"
      data-placeholder={placeholder ? 'true' : undefined}
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
        opacity: placeholder ? 0.7 : 1,
      }}
    >
      <span style={{ fontSize: '0.85rem', opacity: 0.8 }}>{label}</span>
      {value !== undefined ? (
        <span style={{ fontSize: '1.9rem', fontWeight: 800, color: TONE_COLOR[tone] }}>
          {value}
          {unit ? <span style={{ fontSize: '0.95rem', fontWeight: 600, opacity: 0.7, marginLeft: 4 }}>{unit}</span> : null}
        </span>
      ) : null}
      {children}
      {hint ? <span style={{ fontSize: '0.8rem', opacity: 0.65 }}>{hint}</span> : null}
      {placeholder && note ? (
        <span data-testid="metric-note" style={{ fontSize: '0.75rem', opacity: 0.6, fontStyle: 'italic' }}>
          {note}
        </span>
      ) : null}
      {href ? <span style={{ fontSize: '0.8rem', color: 'var(--color-accent)', marginTop: 'auto' }}>詳細を見る →</span> : null}
    </div>
  );

  if (href) {
    return (
      <Link href={href} data-testid="metric-card-link" style={{ textDecoration: 'none', color: 'inherit' }}>
        {body}
      </Link>
    );
  }
  return body;
}
