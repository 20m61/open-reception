import { DangerActionPlaceholder, ReadOnlySection } from '@/components/admin/platform/primitives';

/**
 * プラットフォーム: 外部連携状態（read 中心スケルトン） (issue #90, increment 1)。
 *
 * Vonage / Cognito(Entra) / AWS など外部連携の「登録状態・最終更新日時・接続確認状態」のみを
 * 横断確認する。機密値（API シークレット・秘密鍵）は表示しない（#83 セキュリティ方針）。
 * シークレット再登録などの操作は破壊的操作として確認・昇格・監査を伴う導線に隔離する。
 */
export default function PlatformIntegrationsPage() {
  return (
    <ReadOnlySection
      title="外部連携"
      description="Vonage / Entra(Cognito) / AWS などの連携状態を横断確認します。表示するのは登録状態・最終更新日時・接続確認状態のみで、API シークレットや秘密鍵などの機密値は表示しません。"
    >
      <div style={{ marginTop: 'var(--space-md)', maxWidth: 760 }}>
        <DangerActionPlaceholder label="シークレット再登録 / 連携設定の変更" />
      </div>
    </ReadOnlySection>
  );
}
