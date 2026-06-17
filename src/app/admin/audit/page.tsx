import { listAuditLogs } from '@/lib/mock-backend/reception-log-store';
import type { AuditAction } from '@/domain/reception/log';

export const dynamic = 'force-dynamic';

const ACTION_LABEL: Record<AuditAction, string> = {
  'reception.connected': '受付: 応答',
  'reception.timeout': '受付: 未応答',
  'reception.failed': '受付: 失敗',
  'reception.cancelled': '受付: キャンセル',
  'reception.completed': '受付: 完了',
  'reception.fallback_used': '受付: 代替導線',
  'department.created': '部署: 作成',
  'department.updated': '部署: 更新',
  'department.reordered': '部署: 並び替え',
  'staff.created': '担当者: 作成',
  'staff.updated': '担当者: 更新',
  'kiosk.created': '端末: 登録',
  'kiosk.revoked': '端末: 失効',
  'kiosk.restored': '端末: 再有効化',
  'security.updated': 'セキュリティ設定: 更新',
};

/** 管理画面: 監査ログ一覧 (issue #22, #19)。受付ライフサイクルと管理操作の証跡。 */
export default function AdminAuditPage() {
  const logs = listAuditLogs();
  return (
    <section>
      <h1 style={{ marginTop: 0 }}>監査ログ</h1>
      <p style={{ opacity: 0.8 }}>受付イベントと管理操作の証跡です。個人情報は含めません。</p>
      {logs.length === 0 ? (
        <p data-testid="audit-empty" style={{ opacity: 0.7 }}>
          まだ監査ログはありません。
        </p>
      ) : (
        <table data-testid="audit-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.95rem' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.2)' }}>
              <th style={{ padding: '8px 12px' }}>日時</th>
              <th style={{ padding: '8px 12px' }}>操作</th>
              <th style={{ padding: '8px 12px' }}>主体</th>
              <th style={{ padding: '8px 12px' }}>対象</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id} data-testid="audit-row" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                <td style={{ padding: '8px 12px' }}>{new Date(log.at).toLocaleString('ja-JP')}</td>
                <td style={{ padding: '8px 12px' }}>{ACTION_LABEL[log.action] ?? log.action}</td>
                <td style={{ padding: '8px 12px' }}>{log.actor}</td>
                <td style={{ padding: '8px 12px' }}>
                  {log.targetType ?? '-'}
                  {log.targetId ? <span style={{ opacity: 0.6 }}> {log.targetId}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
