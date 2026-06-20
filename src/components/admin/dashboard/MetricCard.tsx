import type { ReactNode } from 'react';
import { MetricCard as UiMetricCard } from '@/components/admin/ui';

/**
 * 概況の 1 指標を表すカード (issue #86 / #92 increment 2)。
 * クリックすると詳細画面へ遷移できるカード構成（href 指定時）。
 * 実データが無い指標は `placeholder` を立て、design 注記（note）を添える。
 *
 * #92 increment 2: 共有 `ui/MetricCard` への薄い委譲。`metric-card` / `metric-note` /
 * `metric-card-link` の data-testid は呼び出し側互換のため維持する（testId 上書きで注入）。
 */
export type MetricTone = 'neutral' | 'success' | 'warning' | 'danger';

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
  return (
    <UiMetricCard
      label={label}
      value={value}
      unit={unit}
      tone={tone}
      href={href}
      hint={hint}
      note={note}
      placeholder={placeholder}
      testId="metric-card"
      noteTestId="metric-note"
    >
      {children}
    </UiMetricCard>
  );
}
