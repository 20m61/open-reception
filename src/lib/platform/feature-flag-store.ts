/**
 * テナント別機能フラグのストア (issue #83 inc5a)。
 *
 * 永続化は data backend の collection に委譲する（memory=dev/test、DynamoDB=本番）。
 * 1 テナント 1 レコード（id = tenantId）で、上書きしたフラグキーのみ保存する（欠落キーは既定値 =
 * 有効。`effectiveTenantFeatureFlags` で解決）。書き込みは破壊的操作のため、呼び出し側
 * （PATCH /api/platform/tenants/[tenantId]/feature-flags）が **JIT 昇格ゲート（assertElevated）と
 * 監査（feature_flag.updated）** を通した後に呼ぶこと。seed は置かない（既定値がそのままデモ状態）。
 */
import type { TenantFeatureFlagRecord } from '@/domain/platform/feature-flags';
import { getBackend } from '@/lib/data';
import { PLATFORM_LIST_LIMIT } from './store-limits';

const collection = () => getBackend().collection<TenantFeatureFlagRecord>('platform_feature_flags');

/** テナントの上書きレコードを返す（未作成なら undefined = 全機能既定値）。 */
export async function getTenantFeatureFlagRecord(
  tenantId: string,
): Promise<TenantFeatureFlagRecord | undefined> {
  return collection().get(tenantId);
}

/** 全テナントの上書きレコードを返す（プラットフォーム横断サマリ用 read）。 */
export async function listTenantFeatureFlagRecords(): Promise<TenantFeatureFlagRecord[]> {
  return collection().list({ limit: PLATFORM_LIST_LIMIT });
}

/** 上書きレコードを保存する（呼び出し側で昇格ゲート + 監査を通した後に呼ぶ）。 */
export async function putTenantFeatureFlagRecord(record: TenantFeatureFlagRecord): Promise<void> {
  await collection().put(record);
}

/** テスト用に初期状態へ戻す（memory のみ実効）。 */
export async function __resetTenantFeatureFlags(): Promise<void> {
  await collection().reset();
}
