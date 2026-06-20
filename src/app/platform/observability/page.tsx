import { ReadOnlySection } from '@/components/admin/platform/primitives';

/**
 * プラットフォーム: 簡易オブザーバビリティ（read 中心スケルトン） (issue #90, increment 1)。
 *
 * エラー率・呼び出し失敗率・Vonage/認証/Lambda・API エラー・レイテンシ・テナント別利用量・
 * 直近ログ・アラート履歴を read 専用で確認する。直近ログはマスク済みで PII を露出しない。
 * 指標ソースの接続は次増分（本増分はスケルトンのみ）。
 */
export default function PlatformObservabilityPage() {
  return (
    <ReadOnlySection
      title="可観測性"
      description="エラー率・呼び出し失敗率・Vonage/認証/Lambda・API エラー・レイテンシ・テナント別利用量・直近ログ・アラート履歴を確認します（読み取り専用）。直近ログはマスク済みで個人情報を露出しません。指標ソースの接続は次増分です。"
    />
  );
}
