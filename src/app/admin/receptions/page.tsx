import { listReceptionLogs } from '@/lib/data-stores/reception-log-store';
import { RECEPTION_PURPOSES, type CallOutcome } from '@/domain/reception/session';

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

function purposeLabel(id?: string): string {
  return RECEPTION_PURPOSES.find((p) => p.id === id)?.label ?? '-';
}

/**
 * 管理画面: 受付履歴一覧 (issue #19, #22)。
 * 来訪者の個人情報は保持せず、運用に必要な情報のみ表示する。
 */
export default async function AdminReceptionsPage() {
  const logs = await listReceptionLogs();

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>受付履歴</h1>
      <p style={{ opacity: 0.8 }}>
        呼び出し結果・所要時間・代替導線の利用を記録します。来訪者の氏名等の個人情報は保持しません。
      </p>

      {logs.length === 0 ? (
        <p data-testid="receptions-empty" style={{ opacity: 0.7 }}>
          まだ受付履歴はありません。
        </p>
      ) : (
        <table data-testid="receptions-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.95rem' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.2)' }}>
              <th style={{ padding: '8px 12px' }}>開始日時</th>
              <th style={{ padding: '8px 12px' }}>端末</th>
              <th style={{ padding: '8px 12px' }}>目的</th>
              <th style={{ padding: '8px 12px' }}>呼び出し先</th>
              <th style={{ padding: '8px 12px' }}>結果</th>
              <th style={{ padding: '8px 12px' }}>所要</th>
              <th style={{ padding: '8px 12px' }}>代替導線</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id} data-testid="reception-row" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                <td style={{ padding: '8px 12px' }}>{new Date(log.startedAt).toLocaleString('ja-JP')}</td>
                <td style={{ padding: '8px 12px' }}>{log.kioskId}</td>
                <td style={{ padding: '8px 12px' }}>{purposeLabel(log.purpose)}</td>
                <td style={{ padding: '8px 12px' }}>{log.targetLabel ?? '-'}</td>
                <td style={{ padding: '8px 12px', color: OUTCOME_COLOR[log.outcome], fontWeight: 700 }}>
                  {OUTCOME_LABEL[log.outcome]}
                  {log.failureReason ? <span style={{ opacity: 0.7 }}>（{log.failureReason}）</span> : null}
                </td>
                <td style={{ padding: '8px 12px' }}>{Math.round(log.durationMs / 1000)}秒</td>
                <td style={{ padding: '8px 12px' }}>{log.fallbackUsed ? 'あり' : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
