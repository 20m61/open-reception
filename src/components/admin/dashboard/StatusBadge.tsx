import type { OverallStatus } from '@/domain/reception/dashboard-summary';

/**
 * 正常 / 注意 / 異常を視覚的に区別するステータスバッジ (issue #86, increment 1)。
 * 非エンジニアでも分かる業務表現に寄せる（技術用語を前面に出さない）。
 * dashboard サブディレクトリ内に閉じる（トップレベル共通化は #92 の責務）。
 */
const STATUS_META: Record<OverallStatus, { label: string; color: string }> = {
  ok: { label: '正常稼働中', color: 'var(--color-success)' },
  warning: { label: '注意', color: 'var(--color-warning)' },
  critical: { label: '異常', color: 'var(--color-danger)' },
};

export function StatusBadge({ status }: { status: OverallStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      data-testid="dashboard-status-badge"
      data-status={status}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 14px',
        borderRadius: 999,
        fontWeight: 700,
        fontSize: '0.95rem',
        color: meta.color,
        background: 'var(--color-surface)',
        border: `1px solid ${meta.color}`,
      }}
    >
      <span aria-hidden style={{ width: 10, height: 10, borderRadius: '50%', background: meta.color }} />
      {meta.label}
    </span>
  );
}
