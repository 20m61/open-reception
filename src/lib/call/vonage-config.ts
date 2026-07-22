/**
 * Vonage 接続設定の型と、**旧グローバル env** の presence 判定 (issue #4 / #405 Inc3)。
 *
 * `VonageConfig` 型は本番 adapter（`@/adapters/call/vonage`）と session service が使う接続情報の形。
 * 資格情報の **供給源はテナント設定へ移行済み**（`@/lib/platform/provider-resolution`）で、通話/通知の
 * 生成点はグローバル `VONAGE_*` env を読まなくなった（#405 Inc3）。
 *
 * 本ファイルに残る env 参照（`isVonageConfigured` / `isVonageEnabled` / `getVonagePublicConfig`）は、
 * **旧 env の presence 表示（#90/#93 の /platform/integrations）専用**の後方互換 API。資格情報の
 * 供給には使われない。presence 表示自体をテナント設定 presence へ移す移行は別増分（security/admin
 * トラック）で行い、その完了時に本 env 参照も撤去する。
 */
export type VonageConfig = {
  applicationId: string;
  apiKey: string;
  apiSecret: string;
  privateKey: string;
};

/**
 * @deprecated 旧グローバル `VONAGE_*` env の presence 判定（#90/#93 の integrations 表示専用）。
 *   資格情報の供給には使わない（テナント設定 = `resolveProviderForTenant` へ移行済み）。
 */
export function isVonageConfigured(): boolean {
  return Boolean(
    process.env.VONAGE_APPLICATION_ID &&
      process.env.VONAGE_API_KEY &&
      process.env.VONAGE_API_SECRET &&
      process.env.VONAGE_PRIVATE_KEY,
  );
}

/**
 * @deprecated 旧グローバル `VONAGE_*` env の有効化 presence 判定（#90/#93 の integrations 表示専用）。
 *   資格情報の供給には使わない（テナント設定 = `resolveProviderForTenant` へ移行済み）。
 */
export function isVonageEnabled(): boolean {
  return process.env.VONAGE_ENABLED === 'true' && isVonageConfigured();
}

/**
 * @deprecated 旧グローバル env 由来の非機密公開値（applicationId）。資格情報供給の主経路ではない。
 *   テナント別の applicationId は `resolveProviderForTenant().settings.applicationId` から取得する。
 */
export function getVonagePublicConfig(): { applicationId: string } | null {
  if (!isVonageEnabled()) return null;
  const applicationId = process.env.VONAGE_APPLICATION_ID;
  return applicationId ? { applicationId } : null;
}
