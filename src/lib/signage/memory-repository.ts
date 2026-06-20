/**
 * サイネージ設定の in-memory リポジトリ (issue #101, increment 1)。
 *
 * 単体テスト/開発用。本番は BackendSignageRepository（getBackend 経由 dynamodb）を使う。
 * サイト境界（tenantId:siteId）でキーを分離し、他サイトの設定を返さない。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { SignageConfig } from '@/domain/signage/types';
import type { SignageRepository } from './repository';

export class MemorySignageRepository implements SignageRepository {
  private readonly store = new Map<string, SignageConfig>();

  private key(tenantId: TenantId, siteId: SiteId): string {
    return `${tenantId}:${siteId}`;
  }

  async get(tenantId: TenantId, siteId: SiteId): Promise<SignageConfig | undefined> {
    return this.store.get(this.key(tenantId, siteId));
  }

  async put(config: SignageConfig): Promise<void> {
    this.store.set(this.key(config.tenantId, config.siteId), config);
  }
}
