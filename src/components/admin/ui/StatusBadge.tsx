import { radius, space, STATUS_META, type StatusKind } from './tokens';

/**
 * 管理画面 共有ステータスバッジ (issue #92, increment 1)。
 *
 * 既存 dashboard/StatusBadge（ok/warning/critical の 3 値）の正準・拡張版。
 * #92 表示ルールの 5 状態（正常 / 注意 / 異常 / 停止 / メンテナンス中）を統一語彙で扱う。
 * 任意で `label` を上書きできる（業務文言に寄せる場合）。
 */
export function StatusBadge({ status, label }: { status: StatusKind; label?: string }) {
  const meta = STATUS_META[status];
  return (
    <span
      data-testid="ui-status-badge"
      data-status={status}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: space.sm,
        padding: '6px 14px',
        borderRadius: radius.pill,
        fontWeight: 700,
        fontSize: '0.95rem',
        color: meta.color,
        background: 'var(--color-surface)',
        border: `1px solid ${meta.color}`,
      }}
    >
      <span aria-hidden style={{ width: 10, height: 10, borderRadius: '50%', background: meta.color }} />
      {label ?? meta.label}
    </span>
  );
}
