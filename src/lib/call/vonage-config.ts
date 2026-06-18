/**
 * Vonage 接続設定 (issue #4)。
 * secret/private key は server-only な環境変数で扱い、NEXT_PUBLIC_ を付けない。
 * クライアントには短命トークンのみ渡し、ここで読む値を渡さない。
 */
export type VonageConfig = {
  applicationId: string;
  apiKey: string;
  apiSecret: string;
  privateKey: string;
};

/** Vonage の接続情報が環境変数に揃っているか。 */
export function isVonageConfigured(): boolean {
  return Boolean(
    process.env.VONAGE_APPLICATION_ID &&
      process.env.VONAGE_API_KEY &&
      process.env.VONAGE_API_SECRET &&
      process.env.VONAGE_PRIVATE_KEY,
  );
}

/**
 * 本番 Vonage adapter を使うか。設定済み かつ 明示的な有効化フラグが必要。
 * 誤って環境変数が存在しても、明示しない限り Mock を使い続ける。
 */
export function isVonageEnabled(): boolean {
  return process.env.VONAGE_ENABLED === 'true' && isVonageConfigured();
}

export function getVonageConfig(): VonageConfig | null {
  if (!isVonageConfigured()) return null;
  return {
    applicationId: process.env.VONAGE_APPLICATION_ID!,
    apiKey: process.env.VONAGE_API_KEY!,
    apiSecret: process.env.VONAGE_API_SECRET!,
    privateKey: process.env.VONAGE_PRIVATE_KEY!,
  };
}
