import { Integrations } from '@/components/admin/platform/Integrations';
import { ProviderConfig } from '@/components/admin/platform/ProviderConfig';

/**
 * プラットフォーム: 外部連携状態（read 実接続）+ テナント別プロバイダ設定 (issue #90 / #83 / #405)。
 *
 * Vonage / Entra(Cognito) / 共有パスワードなど外部連携・管理ログイン方式の「登録状態・有効状態・
 * 接続確認結果・最終日時」を横断確認し（read）、選択中テナントの CCaaS プロバイダ設定を CRUD する
 * （#405 Inc1）。secret は write-only で値を表示しない（#83 / #405 セキュリティ方針）。read/write とも
 * developer 専用 API（authorizePlatform）が守る。
 */
export default function PlatformIntegrationsPage() {
  return (
    <>
      <Integrations />
      <ProviderConfig />
    </>
  );
}
