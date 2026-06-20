import type { OverallStatus } from '@/domain/reception/dashboard-summary';
import { StatusBadge as UiStatusBadge } from '@/components/admin/ui';
import type { StatusKind } from '@/components/admin/ui';

/**
 * 正常 / 注意 / 異常を視覚的に区別するステータスバッジ (issue #86 / #92 increment 2)。
 * 非エンジニアでも分かる業務表現に寄せる（技術用語を前面に出さない）。
 *
 * #92 increment 2: 視覚は共有 `ui/StatusBadge`（5 状態語彙）へ寄せ、本コンポーネントは
 * `OverallStatus`（ok/warning/critical の 3 値）→ `StatusKind` のマップと業務文言の付与に
 * 専念する薄い委譲にした。`dashboard-status-badge` testid は呼び出し側互換のため維持する。
 */
const STATUS_KIND: Record<OverallStatus, StatusKind> = {
  ok: 'ok',
  warning: 'warning',
  critical: 'critical',
};

/** ダッシュボードでの業務文言（ok は「正常稼働中」と従来表現を保つ）。 */
const STATUS_LABEL: Record<OverallStatus, string> = {
  ok: '正常稼働中',
  warning: '注意',
  critical: '異常',
};

export function StatusBadge({ status }: { status: OverallStatus }) {
  return (
    <span data-testid="dashboard-status-badge" data-status={status}>
      <UiStatusBadge status={STATUS_KIND[status]} label={STATUS_LABEL[status]} />
    </span>
  );
}
