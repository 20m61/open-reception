/**
 * 反映状況の表示ロジック (issue #420 increment 4)。
 *
 * 「公開したのに届いていない端末」を運用者が最短で見つけられるようにするための純関数。
 * 判定そのものは `./deployment.ts`、ここは**並び順と文言**だけを持つ。
 */
import type { DeploymentStatus, ReceptionExperienceVersion } from './types';

export const DEPLOYMENT_STATUS_LABEL: Record<DeploymentStatus, string> = {
  failed: '失敗',
  stale: '旧版で稼働',
  pending: '未反映',
  applied: '反映済み',
};

/** 「対処が要る順」。運用者は失敗と旧版稼働を先に見る。 */
const STATUS_ORDER: Record<DeploymentStatus, number> = {
  failed: 0,
  stale: 1,
  pending: 2,
  applied: 3,
};

export type DeploymentRow = {
  kioskId: string;
  status: DeploymentStatus;
  loadedRevision?: number;
  errorCode?: string;
};

/** 対処が要る順 → 端末 ID 順（コードポイント順で決定的に）。 */
export function sortDeploymentRows<T extends DeploymentRow>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (a.kioskId < b.kioskId ? -1 : a.kioskId > b.kioskId ? 1 : 0),
  );
}

export type RolloutCounts = {
  total: number;
  applied: number;
  pending: number;
  stale: number;
  failed: number;
  complete: boolean;
};

/** 集計の一行サマリ。0 台のときに「完了」と読ませない。 */
export function summaryText(summary: RolloutCounts | null): string {
  if (!summary || summary.total === 0) return '対象端末がありません';
  if (summary.complete) return `全 ${summary.total} 台が反映済み`;
  const parts: string[] = [`${summary.applied}/${summary.total} 台が反映済み`];
  if (summary.failed > 0) parts.push(`失敗 ${summary.failed}`);
  if (summary.stale > 0) parts.push(`旧版 ${summary.stale}`);
  if (summary.pending > 0) parts.push(`未反映 ${summary.pending}`);
  return parts.join(' / ');
}

/** 版の状態表示。承認待ち・公開中などを 1 語で表す。 */
export function versionStateLabel(version: ReceptionExperienceVersion): string {
  switch (version.status) {
    case 'published':
      return version.rolledBackFrom !== undefined
        ? `公開中（rev.${version.rolledBackFrom} へ切り戻し）`
        : '公開中';
    case 'draft':
      return version.approvedBy ? '承認済み（未公開）' : '下書き';
    case 'rolled_back':
      return '切り戻し済み';
    case 'archived':
      return '過去版';
  }
}

/** 版に公開をブロックする検証エラーがあるか（ボタンの活性判定に使う）。 */
export function hasValidationErrors(version: ReceptionExperienceVersion): boolean {
  return (version.validationSummary?.findings ?? []).some((f) => f.severity === 'error');
}
