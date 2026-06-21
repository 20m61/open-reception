/**
 * 担当者応答設定リポジトリの interface と実装 (issue #99 increment 2)。
 *
 * 保存先非依存の抽象。getBackend()（DATA_BACKEND=memory|dynamodb）の Collection に委譲する
 * DataBacked 実装（src/lib/reception/flow-config/repository.ts と同方針）と、単体テスト用の
 * in-memory 実装の両方を提供する。
 *
 * テナント/サイト境界の強制（他テナントの設定を返さない）は tenantId/siteId フィルタで成立
 * させ、認可判定そのものは呼び出し側（service 層 → src/domain/tenant/authorization.ts の
 * 純関数）へ委ねる。設定は tenant×site で 1 レコードのため list 走査で足りる。
 */
import { getBackend } from '@/lib/data';
import type { Collection } from '@/lib/data/backend';
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { StoredStaffResponseConfig } from './types';

export const STAFF_RESPONSE_CONFIG_COLLECTION = 'staff_response_config';

/** tenantId/siteId から決まる安定した設定 ID（1 サイト 1 設定）。 */
export function staffResponseConfigId(tenantId: TenantId, siteId: SiteId): string {
  return `${tenantId}#${siteId}`;
}

export interface StaffResponseConfigRepository {
  /** 指定サイトの設定を返す（未保存なら undefined）。 */
  get(tenantId: TenantId, siteId: SiteId): Promise<StoredStaffResponseConfig | undefined>;
  put(config: StoredStaffResponseConfig): Promise<void>;
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

/** getBackend() に永続化する設定リポジトリ。 */
export class DataBackedStaffResponseConfigRepository implements StaffResponseConfigRepository {
  private readonly col: () => Collection<StoredStaffResponseConfig>;

  constructor() {
    this.col = () =>
      getBackend().collection<StoredStaffResponseConfig>(STAFF_RESPONSE_CONFIG_COLLECTION);
  }

  async get(tenantId: TenantId, siteId: SiteId): Promise<StoredStaffResponseConfig | undefined> {
    const c = await this.col().get(staffResponseConfigId(tenantId, siteId));
    return c && c.tenantId === tenantId && c.siteId === siteId ? c : undefined;
  }

  async put(config: StoredStaffResponseConfig): Promise<void> {
    await this.col().put(config);
  }
}

/** in-memory 実装。getBackend に依存せず、テストで seed を渡して状態を構築する。 */
export class MemoryStaffResponseConfigRepository implements StaffResponseConfigRepository {
  private readonly configs: Map<string, StoredStaffResponseConfig>;

  constructor(seed: StoredStaffResponseConfig[] = []) {
    this.configs = new Map(seed.map((c) => [c.id, clone(c)]));
  }

  async get(tenantId: TenantId, siteId: SiteId): Promise<StoredStaffResponseConfig | undefined> {
    const c = this.configs.get(staffResponseConfigId(tenantId, siteId));
    return c && c.tenantId === tenantId && c.siteId === siteId ? clone(c) : undefined;
  }

  async put(config: StoredStaffResponseConfig): Promise<void> {
    this.configs.set(config.id, clone(config));
  }
}
