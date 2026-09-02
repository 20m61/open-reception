import { Card, DataTable, EmptyState, Section, StatusBadge, type Column } from '@/components/admin/ui';
import { color, space, type StatusKind } from '@/components/admin/ui/tokens';
import {
  DEPLOYMENT_STATUS_LABEL,
  sortDeploymentRows,
  summaryText,
  versionStateLabel,
  type RolloutCounts,
} from '@/domain/experience-version/deployment-view';
import type { DeploymentStatus, ReceptionExperienceVersion } from '@/domain/experience-version/types';

/** 反映状態 → 共有バッジの語彙。運用者は「失敗＝異常・旧版＝注意」で読む。 */
const STATUS_KIND: Record<DeploymentStatus, StatusKind> = {
  applied: 'ok',
  stale: 'warning',
  pending: 'stopped',
  failed: 'critical',
};

export type DeploymentRowView = {
  kioskId: string;
  status: DeploymentStatus;
  loadedRevision?: number;
  errorCode?: string;
};

export type ExperienceVersionsViewProps = {
  versions: readonly ReceptionExperienceVersion[];
  desired: { revision: number; publishedAt?: string } | null;
  deployments: readonly DeploymentRowView[];
  summary: RolloutCounts | null;
};

const versionColumns: ReadonlyArray<Column<ReceptionExperienceVersion>> = [
  { key: 'revision', header: 'rev.', cell: (v) => v.revision, align: 'right' },
  { key: 'state', header: '状態', cell: (v) => versionStateLabel(v) },
  {
    key: 'validation',
    header: '検証',
    cell: (v) => {
      const findings = v.validationSummary?.findings ?? [];
      if (!v.validationSummary) return '未検証';
      const errors = findings.filter((f) => f.severity === 'error').length;
      const warnings = findings.length - errors;
      if (errors > 0) return `エラー ${errors}`;
      return warnings > 0 ? `警告 ${warnings}` : '問題なし';
    },
  },
  { key: 'createdBy', header: '作成', cell: (v) => v.createdBy },
  { key: 'approvedBy', header: '承認', cell: (v) => v.approvedBy ?? '—' },
  { key: 'publishedAt', header: '公開', cell: (v) => v.publishedAt ?? '—' },
];

const deploymentColumns: ReadonlyArray<Column<DeploymentRowView>> = [
  { key: 'kioskId', header: '端末', cell: (d) => d.kioskId },
  {
    key: 'status',
    header: '反映',
    cell: (d) => <StatusBadge status={STATUS_KIND[d.status]} label={DEPLOYMENT_STATUS_LABEL[d.status]} />,
  },
  {
    key: 'loadedRevision',
    header: '読込中の版',
    cell: (d) => (d.loadedRevision === undefined ? '未報告' : `rev.${d.loadedRevision}`),
    align: 'right',
  },
  { key: 'errorCode', header: 'エラー', cell: (d) => d.errorCode ?? '—' },
];

/**
 * 受付体験の版履歴と端末への反映状況の表示 (issue #420 AC「管理画面で desired/loaded 差分を表示」)。
 *
 * データ取得を持たない純粋な表示コンポーネント（`ExperienceVersionsManager` が渡す）。
 * `renderToStaticMarkup` で表示規則をテストできるようにこの分割にしている。
 */
export function ExperienceVersionsView({
  versions,
  desired,
  deployments,
  summary,
}: ExperienceVersionsViewProps) {
  return (
    <>
      <Section title="受付体験の版">
        {versions.length === 0 ? (
          <EmptyState message="まだ版がありません。下書きを保存すると現在の設定が版として固定されます。" />
        ) : (
          <DataTable
            columns={versionColumns}
            rows={[...versions].sort((a, b) => b.revision - a.revision)}
            rowKey={(v) => String(v.revision)}
            testId="experience-versions-table"
          />
        )}
      </Section>

      <Section title="端末への反映状況">
        {desired === null ? (
          <EmptyState message="公開中の版がありません。公開すると端末への反映状況を追跡できます。" />
        ) : (
          <>
            <Card>
              <div style={{ display: 'flex', gap: space.md, alignItems: 'baseline' }}>
                <strong data-testid="rollout-desired">公開中: rev.{desired.revision}</strong>
                <span data-testid="rollout-summary" style={{ color: color.muted }}>
                  {summaryText(summary)}
                </span>
              </div>
            </Card>
            <DataTable
              columns={deploymentColumns}
              rows={sortDeploymentRows(deployments)}
              rowKey={(d) => d.kioskId}
              emptyMessage="この拠点に登録された端末がありません。"
              testId="experience-deployments-table"
            />
          </>
        )}
      </Section>
    </>
  );
}
