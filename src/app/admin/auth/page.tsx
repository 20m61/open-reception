import { AuthMethodSettings } from '@/components/admin/auth/AuthMethodSettings';

export const dynamic = 'force-dynamic';

/**
 * 管理画面: 認証方式設定（Microsoft Entra ID オプション） (issue #70)。
 *
 * provider 切替（password / entra）と Entra の必須設定（issuer / audience / jwksUri /
 * clientId / allowedRoles）の**状態のみ**を表示する。Client Secret / トークン / 各設定値
 * そのものは表示しない（API も値を返さない）。値の変更は env / Secrets Manager で行う。
 */
export default function AdminAuthPage() {
  return <AuthMethodSettings />;
}
