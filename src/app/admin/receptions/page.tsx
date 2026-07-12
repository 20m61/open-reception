import { listReceptionLogs } from '@/lib/data-stores/reception-log-store';
import type { CallOutcome } from '@/domain/reception/session';
import { ReceptionsViewer } from '@/components/admin/receptions/ReceptionsViewer';

export const dynamic = 'force-dynamic';

const OUTCOME_LABEL: Record<CallOutcome, string> = {
  connected: '応答',
  timeout: '未応答',
  failed: '失敗',
  cancelled: 'キャンセル',
};

const OUTCOME_COLOR: Record<CallOutcome, string> = {
  connected: 'var(--color-success)',
  timeout: 'var(--color-warning)',
  failed: 'var(--color-danger)',
  cancelled: 'var(--color-muted)',
};

/**
 * 管理画面: 受付履歴一覧 (issue #19, #22; 検索/フィルタ/ページング/CSV #330 item2)。
 *
 * サーバ側で全ログを取得し（来訪者の個人情報は保持しない設計）、検索/フィルタ/ページング/
 * CSV エクスポートは監査ログ（`/admin/audit`）と同じ設計でクライアント側の
 * `ReceptionsViewer` に委譲する。
 */
export default async function AdminReceptionsPage() {
  const logs = await listReceptionLogs();

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>受付履歴</h1>
      <p style={{ opacity: 0.8 }}>
        呼び出し結果・所要時間・代替導線の利用を記録します。来訪者の氏名等の個人情報は保持しません。
        期間・結果・端末で絞り込み、CSV でエクスポートできます。
      </p>

      <ReceptionsViewer logs={logs} outcomeLabel={OUTCOME_LABEL} outcomeColor={OUTCOME_COLOR} />
    </section>
  );
}
