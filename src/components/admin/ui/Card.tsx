import type { CSSProperties, ReactNode } from 'react';
import { color, font, radius, space, TONE_COLOR, type Tone } from './tokens';

/**
 * 管理画面 共有カード / 指標カード (issue #92, increment 1)。
 *
 * 既存の dashboard/MetricCard・usage/UsageCard を正準化したもの（移行は次増分）。
 * `Card` は汎用の囲み、`MetricCard` は 1 指標を大きく見せる用途。
 */

/** 汎用カード（surface + border の囲み）。 */
export function Card({
  children,
  style,
  testId = 'ui-card',
}: {
  children: ReactNode;
  style?: CSSProperties;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        background: color.surface,
        border: `1px solid ${color.surface2}`,
        borderRadius: radius.md,
        padding: space.md,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/**
 * 1 指標を大きく見せるカード。実データ未接続時は `placeholder` + `note` を添える。
 * コストなど概算値は `hint` に「概算」「予想」を明記する（#92 表示ルール）。
 */
export function MetricCard({
  label,
  value,
  unit,
  tone = 'neutral',
  hint,
  note,
  placeholder = false,
  children,
}: {
  label: string;
  value?: ReactNode;
  unit?: string;
  tone?: Tone;
  hint?: string;
  note?: string;
  placeholder?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      data-testid="ui-metric-card"
      data-tone={tone}
      data-placeholder={placeholder ? 'true' : undefined}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: space.xs,
        padding: space.md,
        borderRadius: radius.md,
        background: color.surface,
        border: `1px solid ${color.surface2}`,
        minHeight: 110,
        height: '100%',
        opacity: placeholder ? 0.7 : 1,
      }}
    >
      <span style={{ fontSize: font.small, opacity: 0.8 }}>{label}</span>
      {value !== undefined ? (
        <span style={{ fontSize: font.metric, fontWeight: 800, color: TONE_COLOR[tone] }}>
          {value}
          {unit ? (
            <span style={{ fontSize: font.body, fontWeight: 600, opacity: 0.7, marginLeft: 4 }}>{unit}</span>
          ) : null}
        </span>
      ) : null}
      {children}
      {hint ? <span style={{ fontSize: '0.8rem', opacity: 0.65 }}>{hint}</span> : null}
      {placeholder && note ? (
        <span data-testid="ui-metric-note" style={{ fontSize: font.caption, opacity: 0.6, fontStyle: 'italic' }}>
          {note}
        </span>
      ) : null}
    </div>
  );
}

/** カードを並べるレスポンシブグリッド（既存 CardGrid の正準）。 */
export function CardGrid({ children, minWidth = 220 }: { children: ReactNode; minWidth?: number }) {
  return (
    <div
      data-testid="ui-card-grid"
      style={{
        display: 'grid',
        gap: space.md,
        gridTemplateColumns: `repeat(auto-fill, minmax(${minWidth}px, 1fr))`,
      }}
    >
      {children}
    </div>
  );
}
