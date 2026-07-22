/**
 * テナント別プロバイダ**非秘密設定**のストア (issue #405 Inc1)。
 *
 * secret の値は保存しない（AC2）。本ストアは `TenantProviderConfig`（非秘密設定のみ）を tenantId で
 * 引く。secret は `tenant-secret-store` に別管理し、presence のみを別途参照する。
 *
 * Inc1 は in-memory（プロセス内 Map）。Inc2 で §9 標準（PlatformRecordRepository / DynamoDB）へ
 * 統合予定。呼び出し側 route はファクトリ API のみに依存するため移行時に route 変更は不要。
 */
import type { TenantProviderConfig } from '@/domain/provider-config/types';

const configs = new Map<string, TenantProviderConfig>();

/** テナントの設定を取得する（未設定は null）。 */
export async function getTenantProviderConfig(tenantId: string): Promise<TenantProviderConfig | null> {
  return configs.get(tenantId) ?? null;
}

/** テナントの設定を upsert する（呼び出し側で認可・監査済み）。 */
export async function putTenantProviderConfig(config: TenantProviderConfig): Promise<void> {
  configs.set(config.tenantId, config);
}

/** テナントの設定を削除する。 */
export async function deleteTenantProviderConfig(tenantId: string): Promise<void> {
  configs.delete(tenantId);
}

/** テスト用に初期化する。 */
export function __resetProviderConfigStore(): void {
  configs.clear();
}
