/**
 * サイネージ設定リポジトリ (issue #101 → #274 ⑦ で §9 標準へ統合)。
 *
 * §9.2（docs/persistence-design.md）の標準イディオム: 保存先非依存の interface +
 * getBackend()（DATA_BACKEND=memory|dynamodb）の Singleton に委譲する実装を 1 つだけ持つ
 * （旧 memory-repository.ts / backend-repository.ts の二重実装は廃止。テストは memory
 * backend + __resetBackend で本実装を直接検証する）。
 *
 * 設定はサイト単位で 1 つなので、サイトごとに別の Singleton キー
 * （signage:<tenantId>:<siteId>）へ保存する。これにより memory/dynamodb のどちらでも
 * サイト境界が物理的に分離される。
 *
 * テナント/サイト境界の強制:
 *   - 参照/保存は tenantId/siteId を必須にし、他サイトの設定を返さない。
 *   - 認可判定そのものは呼び出し側（service）が #80 の純関数で行う。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { SignageConfig } from '@/domain/signage/types';
import { getBackend } from '@/lib/data';

export interface SignageRepository {
  /** サイトの設定を取得する。未保存なら undefined（呼び出し側が既定へフォールバック）。 */
  get(tenantId: TenantId, siteId: SiteId): Promise<SignageConfig | undefined>;
  /** サイトの設定を上書き保存する（read-modify-write は呼び出し側で行う）。 */
  put(config: SignageConfig): Promise<void>;
}

/** Singleton キー。テナント/サイトごとに分離する。 */
export function signageKey(tenantId: TenantId, siteId: SiteId): string {
  return `signage:${tenantId}:${siteId}`;
}

/** getBackend() に永続化するサイネージ設定リポジトリ（単一実装）。 */
export class DataBackedSignageRepository implements SignageRepository {
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
