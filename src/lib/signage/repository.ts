/**
 * サイネージ設定リポジトリの抽象 (issue #101, increment 1)。
 *
 * 設定はサイト単位で 1 つ。保存先非依存の interface を定義し、実装は getBackend()
 * の Singleton を使う BackendSignageRepository（./store.ts）が担う。memory（dev/test/CI）
 * と dynamodb（本番）の切替は getBackend() 側で行う（docs/persistence-design.md）。
 *
 * テナント/サイト境界の強制:
 *   - 参照/保存は tenantId/siteId を必須にし、他サイトの設定を返さない。
 *   - 認可判定そのものは呼び出し側（service）が #80 の純関数で行う。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { SignageConfig } from '@/domain/signage/types';

export interface SignageRepository {
  /** サイトの設定を取得する。未保存なら undefined（呼び出し側が既定へフォールバック）。 */
  get(tenantId: TenantId, siteId: SiteId): Promise<SignageConfig | undefined>;
  /** サイトの設定を上書き保存する（read-modify-write は呼び出し側で行う）。 */
  put(config: SignageConfig): Promise<void>;
}
