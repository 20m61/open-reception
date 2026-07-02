/**
 * テナント別機能フラグのストア (issue #83 inc5a)。
 *
 * #274 ③ で §9 標準（docs/persistence-design.md）へ統合: 永続化は TenantFeatureFlagRepository
 * （./repository.ts、getBackend() 委譲の単一実装）に閉じ、本ファイルはプロセス共有ファクトリ
 * （getTenantFeatureFlagRepository）と互換 API を担う。呼び出し側 route の変更は不要。
 *
 * 1 テナント 1 レコード（id = tenantId）で、上書きしたフラグキーのみ保存する（欠落キーは既定値 =
 * 有効。`effectiveTenantFeatureFlags` で解決）。書き込みは破壊的操作のため、呼び出し側
 * （PATCH /api/platform/tenants/[tenantId]/feature-flags）が **JIT 昇格ゲート（assertElevated）と
 * 監査（feature_flag.updated）** を通した後に呼ぶこと。seed は置かない（既定値がそのままデモ状態）。
 */
import type { TenantFeatureFlagRecord } from '@/domain/platform/feature-flags';
import {
  DataBackedTenantFeatureFlagRepository,
  type TenantFeatureFlagRepository,
} from './repository';

let repository: TenantFeatureFlagRepository | undefined;

/** プロセス共有の TenantFeatureFlag リポジトリ（§9.2 のファクトリ）。 */
export function getTenantFeatureFlagRepository(): TenantFeatureFlagRepository {
  if (!repository) {
    repository = new DataBackedTenantFeatureFlagRepository();
  }
  return repository;
}

/** テナントの上書きレコードを返す（未作成なら undefined = 全機能既定値）。 */
export async function getTenantFeatureFlagRecord(
  tenantId: string,
): Promise<TenantFeatureFlagRecord | undefined> {
  return getTenantFeatureFlagRepository().getRecord(tenantId);
}

/** 全テナントの上書きレコードを返す（プラットフォーム横断サマリ用 read）。 */
export async function listTenantFeatureFlagRecords(): Promise<TenantFeatureFlagRecord[]> {
  return getTenantFeatureFlagRepository().listRecords();
}

/** 上書きレコードを保存する（呼び出し側で昇格ゲート + 監査を通した後に呼ぶ）。 */
export async function putTenantFeatureFlagRecord(record: TenantFeatureFlagRecord): Promise<void> {
  await getTenantFeatureFlagRepository().putRecord(record);
}

/** テスト用に初期状態へ戻す（memory のみ実効）。 */
export async function __resetTenantFeatureFlags(): Promise<void> {
  await getTenantFeatureFlagRepository().reset();
}
