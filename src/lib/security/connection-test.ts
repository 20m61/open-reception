/**
 * 外部連携の接続テスト (issue #93, increment 1)。
 *
 * inc1 はネットワーク発信を行わない「設定検証（config check）」に留める:
 *   - 必要な設定が揃っているか / 有効化されているかを確認するだけ。
 *   - 実際の Vonage への接続確認・テスト発信は実認証情報と実機が要るため次増分
 *     （#65 にスタック）。本番発信とは明確に区別し、ここでは発信しない。
 *
 * セキュリティ: 戻り値の errorSummary に secret/private key を絶対に含めない。
 * 揃っていない設定の **名前**（VONAGE_API_SECRET 等）のみを返す。
 */
import { isVonageConfigured, isVonageEnabled } from '@/lib/call/vonage-config';

export type ConnectionTestOutcome = {
  result: 'success' | 'failure';
  /** 機密を含めない短い要約。 */
  summary?: string;
};

/** Vonage 連携の設定検証。値は読まず、揃っているかだけを判定する。 */
export function checkVonageConnection(
  env: Record<string, string | undefined> = process.env,
): ConnectionTestOutcome {
  const required = [
    'VONAGE_APPLICATION_ID',
    'VONAGE_API_KEY',
    'VONAGE_API_SECRET',
    'VONAGE_PRIVATE_KEY',
  ];
  const missing = required.filter((k) => !env[k] || env[k]?.trim() === '');
  if (missing.length > 0) {
    return { result: 'failure', summary: `未設定の項目: ${missing.join(', ')}` };
  }
  if (!isVonageConfigured()) {
    return { result: 'failure', summary: '接続設定が不完全です' };
  }
  if (!isVonageEnabled()) {
    return { result: 'failure', summary: 'VONAGE_ENABLED=true で有効化されていません' };
  }
  // inc1: 設定が揃い有効化済み。実発信は行わず config check 成功として扱う。
  return { result: 'success', summary: '設定検証 OK（実発信は次増分）' };
}

/** id から接続テストを振り分ける。未知の連携は failure。 */
export function runConnectionTest(
  id: string,
  env: Record<string, string | undefined> = process.env,
): ConnectionTestOutcome {
  if (id === 'vonage') return checkVonageConnection(env);
  return { result: 'failure', summary: '未知の連携です' };
}
