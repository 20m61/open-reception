import type { CallOutcome } from '@/domain/reception/session';
import type { RecentCall } from '@/domain/reception/dashboard-summary';
import { DataTable, type Column } from '@/components/admin/ui';

/**
 * 直近の呼び出し履歴 (issue #86 / #92 increment 2)。
 * 来訪者の氏名等 PII は含めず、呼び出し対象名・成否・所要時間のみ。
 * 空状態では自然な案内を出す。
 *
 * #92 increment 2: 素朴な table 描画を共有 `ui/DataTable`（列定義ベース・空時 EmptyState）
 * へ寄せた。結果セルの色付け・代替導線注記など描画ロジックは列定義に閉じる。
 */
const OUTCOME_META: Record<CallOutcome, { label: string; color: string }> = {
  connected: { label: '応答', color: 'var(--color-success)' },
  timeout: { label: '未応答', color: 'var(--color-warning)' },
  failed: { label: '失敗', color: 'var(--color-danger)' },
  cancelled: { label: 'キャンセル', color: 'var(--color-text)' },
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}秒`;
  return `${Math.floor(sec / 60)}分${sec % 60}秒`;
}

const columns: ReadonlyArray<Column<RecentCall>> = [
  { key: 'time', header: '時刻', cell: (c) => formatTime(c.startedAt) },
  { key: 'target', header: '呼び出し先', cell: (c) => c.targetLabel ?? '-' },
  {
    key: 'outcome',
    header: '結果',
    cell: (c) => {
      const meta = OUTCOME_META[c.outcome];
      return (
        <span style={{ color: meta.color }}>
          {meta.label}
          {c.fallbackUsed ? <span style={{ opacity: 0.6, fontSize: '0.8rem' }}>（代替導線）</span> : null}
        </span>
      );
    },
  },
  { key: 'duration', header: '所要', cell: (c) => formatDuration(c.durationMs) },
];

export function RecentCalls({ calls }: { calls: readonly RecentCall[] }) {
  return (
    <DataTable
      columns={columns}
      rows={calls}
      rowKey={(c) => c.id}
      emptyMessage="まだ受付履歴がありません。"
      testId="recent-calls-table"
    />
  );
}
