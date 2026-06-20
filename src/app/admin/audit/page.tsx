import { listAuditLogs } from '@/lib/mock-backend/reception-log-store';
import type { AuditAction } from '@/domain/reception/log';

export const dynamic = 'force-dynamic';

// 非網羅マップ（フォールバックあり）。新しい AuditAction 追加でこの画面の編集を不要にし、
// 並行トラックでの編集衝突を避ける。未登録のアクションは raw 文字列で表示する。
const ACTION_LABEL: Partial<Record<AuditAction, string>> = {
  'reception.connected': '受付: 接続確定',
  'reception.answered': '受付: 担当者応答',
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
  'voice.updated': '音声設定: 更新',
  'asset.created': 'アセット: 登録',
  'asset.updated': 'アセット: 更新',
  'motion.updated': 'モーション割り当て: 更新',
  'reservation.created': '来訪予約: 作成',
  'reservation.updated': '来訪予約: 更新',
  'reservation.cancelled': '来訪予約: キャンセル',
  'reservation.revoked': '来訪予約: 失効',
  'reservation.token_issued': '来訪予約: QR発行',
  'reservation.token_reissued': '来訪予約: QR再発行',
  'site.created': '拠点: 作成',
  'site.updated': '拠点: 更新',
  'call_route.created': '呼び出しルート: 作成',
  'call_route.updated': '呼び出しルート: 更新',
  'call_route.deleted': '呼び出しルート: 削除',
  'auth_config.updated': '認証設定: 更新',
  'integration.updated': '外部連携: 更新',
  'integration.tested': '外部連携: 接続テスト',
  'secret.updated': 'シークレット: 更新',
  'secret.cleared': 'シークレット: 削除',
  'reception.staff_responded': '受付: 担当者応答アクション',
  'device.token_reissued': '端末: トークン再発行',
  'device.disabled': '端末: 無効化',
  'device.enabled': '端末: 有効化',
  'reception_flow.created': '受付フロー: 作成',
  'reception_flow.updated': '受付フロー: 更新',
  'reception_flow.deleted': '受付フロー: 削除',
  'signage.updated': 'サイネージ: 更新',
  'visitor.checked_out': '来訪者: 退館',
  'stay.updated': '滞在状態: 更新',
};

/** 管理画面: 監査ログ一覧 (issue #22, #19)。受付ライフサイクルと管理操作の証跡。 */
export default async function AdminAuditPage() {
  const logs = await listAuditLogs();
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
