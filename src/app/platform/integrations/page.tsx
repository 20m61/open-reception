import { Integrations } from '@/components/admin/platform/Integrations';

/**
 * プラットフォーム: 外部連携状態（read 実接続） (issue #90, increment 3 / #83)。
 *
 * Vonage / Entra(Cognito) / 共有パスワードなど外部連携・管理ログイン方式の「登録状態・有効状態・
 * 接続確認結果・最終日時」のみを横断確認する。機密値（API シークレット・秘密鍵）は表示しない
 * （#83 セキュリティ方針）。シークレット再登録などの操作は破壊的操作として確認・昇格・監査を
 * 伴う導線に隔離する（次増分）。read は developer 専用 API authorizePlatform() が守る。
 */
export default function PlatformIntegrationsPage() {
  return <Integrations />;
}
