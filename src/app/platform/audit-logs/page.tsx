import { AuditLogs } from '@/components/admin/platform/AuditLogs';

export const dynamic = 'force-dynamic';

/**
 * プラットフォーム: 監査ログ（テナント横断・マスク済み read） (issue #90, increment 2)。
 * data 取得・認可は /api/platform/audit-logs（developer 専用 read）。
 * actor はマスク済み、metadata は非表示で PII・機密を露出しない。
 */
export default function PlatformAuditLogsPage() {
  return <AuditLogs />;
}
