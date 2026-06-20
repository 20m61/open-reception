import { ReadOnlySection } from '@/components/admin/platform/primitives';

/**
 * プラットフォーム: 監査ログ（read 中心スケルトン） (issue #90, increment 1)。
 *
 * テナント横断のマスク済み監査ログを read 専用で確認する。既存の AuditAction / 監査基盤
 * （src/domain/reception/log.ts・src/app/admin/audit）を参照する設計で、本増分では
 * platform 専用の監査読み取り配線は次増分に回す（log.ts は編集しない）。
 */
export default function PlatformAuditLogsPage() {
  return (
    <ReadOnlySection
      title="監査ログ"
      description="プラットフォーム操作のマスク済み監査ログを横断確認します（読み取り専用）。個人情報・機密値は記録・表示しません。platform 専用の監査読み取り配線は次増分です。"
    />
  );
}
