/**
 * Vonage 接続設定の型と、**公開 applicationId** のテナント設定解決 (issue #4 / #405 Inc3)。
 *
 * `VonageConfig` 型は本番 adapter（`@/adapters/call/vonage`）と session service が使う接続情報の形。
 * 資格情報の **供給源はテナント設定**（`@/lib/platform/provider-resolution`）で、通話/通知/公開値の
 * 生成点はグローバル `VONAGE_*` env を読まない（#405 Inc3 → #4 で公開値の env 経路も撤去）。
 *
 * presence 表示（#90/#93 の /platform/integrations・/admin/integrations）の旧グローバル env 直読み
 * （`isVonageConfigured` / `isVonageEnabled`）はテナント設定 presence（`getVonagePresenceForTenant`）へ
 * 移行済み。
 *
 * `getVonagePublicConfigForTenant` は kiosk / staff の**クライアント SDK 用公開 applicationId**を供給する。
 * これは presence 表示ではなく、通話セッションのトークン配布時にクライアントへ渡す非機密の公開識別子で、
 * **テナント設定（`TenantProviderConfig.applicationId`）から server-only で解決する**（旧グローバル
 * `VONAGE_APPLICATION_ID` env 経路は撤去）。未設定テナント（provider!=vonage / disabled / secret 未設定 /
 * applicationId 未設定）は null（＝機能無効）。
 *
 * **server-only**: `provider-resolution` を経由し secret 値（`SecretValue`）を扱う依存を持つため、
 * 'use client' から import 不可（`src/domain/provider-config/server-only-import.test.ts` が静的に固定）。
 * クライアントは applicationId を token API 応答（`applicationId` フィールド）経由でのみ受け取る。
 */
import {
  resolveProviderForTenant,
  type ResolveProviderDeps,
} from '@/lib/platform/provider-resolution';

export type VonageConfig = {
  applicationId: string;
  apiKey: string;
  apiSecret: string;
  privateKey: string;
};

/**
 * テナント設定由来の非機密公開値（applicationId）。**presence 表示には使わない**。
 * kiosk/staff のクライアント SDK 初期化用に、テナントが vonage 解決かつ applicationId 設定済みの
 * ときだけ公開 applicationId を返す（それ以外は null＝機能無効）。secret（bundle）は返さない。
 * `tenantId` は呼び出し元の認可済みコンテキスト由来のみ渡すこと（越境防止）。
 */
export async function getVonagePublicConfigForTenant(
  tenantId: string,
  deps?: ResolveProviderDeps,
): Promise<{ applicationId: string } | null> {
  const resolved = await resolveProviderForTenant(tenantId, deps);
  if (resolved.provider !== 'vonage') return null;
  const applicationId = resolved.settings.applicationId;
  return applicationId ? { applicationId } : null;
}
