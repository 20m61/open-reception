/**
 * getBackend() ベースのサイネージ設定リポジトリ (issue #101, increment 1)。
 *
 * 設定はサイト単位で 1 つなので、サイトごとに別の Singleton キー
 * （signage:<tenantId>:<siteId>）へ保存する。これにより memory/dynamodb の
 * どちらでもサイト境界が物理的に分離される（docs/persistence-design.md）。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { SignageConfig } from '@/domain/signage/types';
import { getBackend } from '@/lib/data';
import type { SignageRepository } from './repository';

/** Singleton キー。テナント/サイトごとに分離する。 */
export function signageKey(tenantId: TenantId, siteId: SiteId): string {
  return `signage:${tenantId}:${siteId}`;
}

export class BackendSignageRepository implements SignageRepository {
  private store(tenantId: TenantId, siteId: SiteId) {
    return getBackend().singleton<SignageConfig>(signageKey(tenantId, siteId));
  }

  async get(tenantId: TenantId, siteId: SiteId): Promise<SignageConfig | undefined> {
    const config = await this.store(tenantId, siteId).get();
    // 万一別サイトのデータが返っても境界違反を返さない（防御的）。
    if (config && (config.tenantId !== tenantId || config.siteId !== siteId)) return undefined;
    return config;
  }

  async put(config: SignageConfig): Promise<void> {
    await this.store(config.tenantId, config.siteId).put(config);
  }
}
