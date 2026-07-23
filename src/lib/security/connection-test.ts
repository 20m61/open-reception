/**
 * 外部連携の接続テスト (issue #93, increment 1 / #405 Inc3)。
 *
 * inc1 はネットワーク発信を行わない「設定検証（config check）」に留める:
 *   - テナント設定で必要な設定が揃っているか / 有効化されているかを確認するだけ。
 *   - 実際の Vonage への接続確認・テスト発信は実認証情報と実機が要るため次増分
 *     （#65 にスタック）。本番発信とは明確に区別し、ここでは発信しない。
 *
 * presence の供給源はテナント設定（`getVonagePresenceForTenant`）へ移行済み。旧グローバル
 * `VONAGE_*` env は読まない（#405 Inc3）。
 *
 * セキュリティ: 戻り値の summary に secret/private key を絶対に含めない。テナント設定 presence
 * （configured/enabled の状態のみ）から判定し、値も secret 名も外へ出さない。
 */
import type { IntegrationPresence } from '@/lib/platform/integration-presence';

export type ConnectionTestOutcome = {
  result: 'success' | 'failure';
  /** 機密を含めない短い要約。 */
  summary?: string;
};

/** presence の判定に必要な最小形（configured/enabled の状態のみ。値は含まない）。 */
export type ConnectionPresence = Pick<IntegrationPresence, 'configured' | 'enabled'>;

/** Vonage 連携の設定検証。テナント設定 presence（値なし）から揃っているかだけを判定する。 */
export function checkVonageConnection(presence: ConnectionPresence): ConnectionTestOutcome {
  if (!presence.configured) {
    return { result: 'failure', summary: 'テナント設定で Vonage の資格情報が揃っていません' };
  }
  if (!presence.enabled) {
    return { result: 'failure', summary: 'テナント設定で Vonage が有効化されていません' };
  }
  // inc1: 設定が揃い有効化済み。実発信は行わず config check 成功として扱う。
  return { result: 'success', summary: '設定検証 OK（実発信は次増分）' };
}

/** id から接続テストを振り分ける。未知の連携は failure。 */
export function runConnectionTest(id: string, presence: ConnectionPresence): ConnectionTestOutcome {
  if (id === 'vonage') return checkVonageConnection(presence);
  return { result: 'failure', summary: '未知の連携です' };
}
