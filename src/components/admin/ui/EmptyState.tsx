import type { ReactNode } from 'react';
import { color, font, radius, space } from './tokens';

/**
 * 管理画面 共有 空状態 (issue #92, increment 1)。
 *
 * 一覧が 0 件のときに自然な案内を出す（既存 RecentCalls の empty 文言の正準）。
 * 任意で見出し・補足・アクション（追加導線など）を添えられる。
 */
export function EmptyState({
  title,
  message,
  action,
  testId = 'ui-empty-state',
}: {
  title?: string;
  message?: ReactNode;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: space.sm,
        padding: space.xl,
        textAlign: 'center',
        borderRadius: radius.md,
        border: `1px dashed ${color.borderStrong}`,
        color: color.muted,
      }}
    >
      {title ? <strong style={{ fontSize: font.label, color: color.text }}>{title}</strong> : null}
      {message ? <span style={{ fontSize: font.body }}>{message}</span> : null}
      {action ? <div style={{ marginTop: space.xs }}>{action}</div> : null}
    </div>
  );
}
