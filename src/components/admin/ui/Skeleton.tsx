import type { CSSProperties } from 'react';
import { color, radius, space } from './tokens';

/**
 * 管理画面 共有 スケルトン (issue #94, increment 1)。
 *
 * SPA ライクなルート遷移時に、領域単位で「読み込み中」を即時に示すためのプレースホルダ。
 * App Router の `loading.tsx` から使い、共通シェル（サイドバー/ヘッダ）を再マウントせずに
 * 本文だけを差し替える体験を支える。
 *
 * 純粋な見た目のみ。アニメーションは CSS（globals.css の `@keyframes admin-skeleton-pulse`）
 * に委ね、`prefers-reduced-motion` を尊重する。
 */
export function Skeleton({
  width = '100%',
  height = 16,
  rounded = radius.sm,
  style,
  testId = 'ui-skeleton',
}: {
  /** 幅（px or CSS 値）。 */
  width?: number | string;
  /** 高さ（px or CSS 値）。 */
  height?: number | string;
  /** 角丸（px）。 */
  rounded?: number;
  style?: CSSProperties;
  testId?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      style={{
        display: 'block',
        width,
        height,
        borderRadius: rounded,
        background: color.surface2,
        animation: 'admin-skeleton-pulse 1.4s ease-in-out infinite',
        ...style,
      }}
    />
  );
}

/**
 * 一覧/詳細の読み込み中に出す行スケルトンのまとまり。
 * `loading.tsx` から最小設定で使える既定形（見出し + 数行）。
 */
export function SkeletonBlock({
  rows = 4,
  testId = 'ui-skeleton-block',
}: {
  /** 本文行数。 */
  rows?: number;
  testId?: string;
}) {
  const safeRows = Math.max(0, rows);
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      data-testid={testId}
      style={{ display: 'flex', flexDirection: 'column', gap: space.sm }}
    >
      <span
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
        }}
      >
        読み込み中
      </span>
      <Skeleton width="40%" height={28} rounded={radius.md} />
      {Array.from({ length: safeRows }, (_, i) => (
        <Skeleton key={i} height={20} width={i === safeRows - 1 ? '70%' : '100%'} />
      ))}
    </div>
  );
}
