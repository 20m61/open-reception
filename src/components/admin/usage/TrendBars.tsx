import type { CSSProperties } from 'react';
import { color, font, radius, space } from '@/components/admin/ui';

/**
 * 日次推移の簡易バーチャート (issue #89, increment 2)。
 *
 * 外部チャートライブラリを足さず（#105 のライセンス確認を避ける）、CSS だけで
 * 「期間内の推移」を直感的に見せる軽量表示。値 0 の日も等幅の空バーで連続性を保つ。
 * アクセシビリティ用に各バーへ title（日付・値）を付ける。PII は扱わない。
 */
export type TrendBar = {
  /** バケットキー（YYYY-MM-DD）。 */
  date: string;
  /** バーの高さに使う数値（>=0）。 */
  value: number;
};

export function TrendBars({
  data,
  unit = '',
  testId = 'trend-bars',
  emptyMessage = 'この期間のデータはありません。',
}: {
  data: readonly TrendBar[];
  unit?: string;
  testId?: string;
  emptyMessage?: string;
}) {
  const max = data.reduce((m, d) => Math.max(m, d.value), 0);
  const hasAny = data.some((d) => d.value > 0);

  if (data.length === 0 || !hasAny) {
    return (
      <p data-testid={`${testId}-empty`} style={{ opacity: 0.6, fontSize: font.small }}>
        {emptyMessage}
      </p>
    );
  }

  return (
    <div
      data-testid={testId}
      role="img"
      aria-label={`日次推移（最大 ${max}${unit}）`}
      style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 96, width: '100%' }}
    >
      {data.map((d) => {
        const heightPct = max > 0 ? Math.max(2, Math.round((d.value / max) * 100)) : 2;
        return (
          <div
            key={d.date}
            data-testid={`${testId}-bar`}
            title={`${d.date}: ${d.value}${unit}`}
            style={{
              flex: 1,
              minWidth: 0,
              height: `${heightPct}%`,
              background: d.value > 0 ? color.accent : color.surface2,
              borderRadius: radius.sm,
            }}
          />
        );
      })}
    </div>
  );
}

/** 推移セクションの囲み（見出し + 期間ラベル + バー）。 */
export function TrendSection({
  title,
  children,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  testId?: string;
}) {
  const wrap: CSSProperties = { display: 'flex', flexDirection: 'column', gap: space.sm };
  return (
    <section data-testid={testId} style={wrap}>
      <h2 style={{ fontSize: '1.05rem', margin: 0 }}>{title}</h2>
      {children}
    </section>
  );
}
