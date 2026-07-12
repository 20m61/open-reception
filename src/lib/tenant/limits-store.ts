/**
 * テナント別保持期間設定（TenantLimits）のストア (issue #313)。
 *
 * §9.2（docs/persistence-design.md）の標準イディオム: ドメイン語彙の interface +
 * getBackend()（DATA_BACKEND=memory|dynamodb）の Collection に委譲する実装を 1 つだけ持つ。
 * `src/lib/platform/feature-flag-store.ts`（1 テナント 1 レコード・上書きのみ保存）と同じ形。
 *
 * 書き込みは破壊的操作ではないが、テナントの保存期間ポリシーを変える運用操作のため、
 * 呼び出し側（将来の admin/platform API）で認可・監査を通した後に呼ぶこと。
 */
import type { TenantLimits } from '@/domain/tenant/limits';
import { getBackend } from '@/lib/data';
import type { Collection } from '@/lib/data/backend';

export const TENANT_LIMITS_COLLECTION = 'tenant_limits';

export interface TenantLimitsRepository {
  /** テナントの上書きレコードを返す（未作成なら undefined = 全項目既定値）。 */
  get(tenantId: string): Promise<TenantLimits | undefined>;
  /** 上書きレコードを保存する（作成または置換）。 */
  put(limits: TenantLimits): Promise<void>;
  /** テスト用: 初期状態へ戻す（memory backend のみ実効）。 */
  reset(): Promise<void>;
}

/** getBackend() の Collection に永続化するテナント保持期間リポジトリ。 */
export class DataBackedTenantLimitsRepository implements TenantLimitsRepository {
  private readonly col: () => Collection<TenantLimits> = () =>
    getBackend().collection<TenantLimits>(TENANT_LIMITS_COLLECTION);

  async get(tenantId: string): Promise<TenantLimits | undefined> {
    return this.col().get(tenantId);
  }

  async put(limits: TenantLimits): Promise<void> {
    await this.col().put(limits);
  }

  async reset(): Promise<void> {
    await this.col().reset();
  }
}

let repository: TenantLimitsRepository | undefined;

/** プロセス共有の TenantLimitsRepository（§9.2 のファクトリ）。 */
export function getTenantLimitsRepository(): TenantLimitsRepository {
  if (!repository) {
    repository = new DataBackedTenantLimitsRepository();
  }
  return repository;
}

/** テスト用に初期状態へ戻す（memory のみ実効）。 */
export async function __resetTenantLimits(): Promise<void> {
  await getTenantLimitsRepository().reset();
}
