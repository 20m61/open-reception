import type { ReactNode } from 'react';
import { CardGrid as UiCardGrid, MetricCard as UiMetricCard } from '@/components/admin/ui';

/**
 * 利用量・コストの 1 指標カード (issue #89 / #92 increment 2)。
 *
 * #92 increment 2: 共有 `ui/MetricCard` への薄い委譲。usage 系は placeholder でなくても
 * note を出すため `alwaysShowNote` を立てる。`usage-card` / `usage-note` の data-testid は
 * 呼び出し側互換のため testId 上書きで維持する。CardGrid も `ui/CardGrid` へ集約する。
 */
export type CardTone = 'neutral' | 'success' | 'warning' | 'danger';

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
    <UiMetricCard
      label={label}
      value={value}
      unit={unit}
      tone={tone}
      hint={hint}
      note={note}
      alwaysShowNote
      testId="usage-card"
      noteTestId="usage-note"
    >
      {children}
    </UiMetricCard>
  );
}

/** カードを並べるレスポンシブグリッド（`ui/CardGrid` への委譲）。 */
export function CardGrid({ children }: { children: ReactNode }) {
  return <UiCardGrid>{children}</UiCardGrid>;
}
