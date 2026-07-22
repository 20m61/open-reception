/**
 * Vonage 接続設定の型と、旧グローバル env 由来の**公開 applicationId** の供給 (issue #4 / #405 Inc3)。
 *
 * `VonageConfig` 型は本番 adapter（`@/adapters/call/vonage`）と session service が使う接続情報の形。
 * 資格情報の **供給源はテナント設定へ移行済み**（`@/lib/platform/provider-resolution`）で、通話/通知の
 * 生成点はグローバル `VONAGE_*` env を読まなくなった（#405 Inc3）。
 *
 * presence 表示（#90/#93 の /platform/integrations・/admin/integrations）の旧グローバル env 直読み
 * （`isVonageConfigured` / `isVonageEnabled`）はテナント設定 presence（`getVonagePresenceForTenant`）へ
 * 移行し、本ファイルから**撤去した**（#405 Inc3 の申し送り解消）。
 *
 * 残る `getVonagePublicConfig` は kiosk / staff の**クライアント SDK 用公開 applicationId**を供給する
 * 別経路（presence 表示ではない）。この applicationId 供給のテナント設定への移行は kiosk/voice トラックの
 * 別増分で行う。それまでは後方互換のため旧グローバル env を読む（非機密の公開識別子）。
 */
export type VonageConfig = {
  applicationId: string;
  apiKey: string;
  apiSecret: string;
  privateKey: string;
};

/**
 * 旧グローバル env 由来の非機密公開値（applicationId）。**presence 表示には使わない**。
 * kiosk/staff のクライアント SDK 初期化用に、Vonage が有効化・設定済みのときだけ公開 applicationId を返す。
 * テナント別の applicationId は `resolveProviderForTenant().settings.applicationId` から取得する
 * （こちらへの移行は kiosk/voice トラックの別増分）。
 */
export function getVonagePublicConfig(): { applicationId: string } | null {
  const enabled =
    process.env.VONAGE_ENABLED === 'true' &&
    Boolean(
      process.env.VONAGE_APPLICATION_ID &&
        process.env.VONAGE_API_KEY &&
        process.env.VONAGE_API_SECRET &&
        process.env.VONAGE_PRIVATE_KEY,
    );
  if (!enabled) return null;
  const applicationId = process.env.VONAGE_APPLICATION_ID;
  return applicationId ? { applicationId } : null;
}
