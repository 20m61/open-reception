import { DangerActionPlaceholder, ReadOnlySection } from '@/components/admin/platform/primitives';

/**
 * プラットフォーム: 機能フラグ / 利用制限（read 中心スケルトン） (issue #90, increment 1)。
 *
 * Vonage 電話通知・Entra/Google ログイン・音声合成・VRM 受付などのフラグ、受付端末上限・
 * 月間通話数上限・概算コスト上限の確認 UI を次増分でテナント単位に実装する。
 * 変更は破壊的操作のため確認・昇格・監査を伴う導線に隔離する。
 */
export default function PlatformFeatureFlagsPage() {
  return (
    <ReadOnlySection
      title="機能フラグ / 利用制限"
      description="テナント単位の機能フラグ（Vonage 電話通知・Entra/Google ログイン・音声合成・VRM 受付）と利用上限（受付端末・月間通話数・概算コスト上限）を確認します。確認 UI は次増分で接続します。"
    >
      <div style={{ marginTop: 'var(--space-md)', maxWidth: 760 }}>
        <DangerActionPlaceholder label="機能フラグ / 利用制限の変更" />
      </div>
    </ReadOnlySection>
  );
}
