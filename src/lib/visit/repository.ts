/**
 * 滞在記録リポジトリの interface (issue #102, increment 1)。
 *
 * 保存先非依存の抽象のみを定義する。getBackend() ベースの実装（backend-repository.ts）と、
 * 単体テスト用の in-memory 実装（memory-repository.ts）を提供する。
 *
 * テナント境界の強制:
 *   - すべての参照系は tenantId/siteId を必須にし、他テナント/他サイトの滞在を返さない。
 *   - 認可判定そのものは呼び出し側が src/domain/tenant/authorization.ts の純関数で行う。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { StayId, VisitStay } from '@/domain/visit/types';

export type RepoError = { code: 'not_found' | 'conflict' | 'invalid_input'; message: string };
export type RepoResult<T> = { ok: true; value: T } | { ok: false; error: RepoError };

export interface StayRepository {
  /** 指定サイト配下の滞在のみ返す（テナント/サイト境界）。 */
  list(tenantId: TenantId, siteId: SiteId): Promise<VisitStay[]>;
  /** id 取得。tenantId/siteId が一致しない場合は undefined（越境を返さない）。 */
  get(tenantId: TenantId, siteId: SiteId, id: StayId): Promise<VisitStay | undefined>;
  /** 新規作成。id 重複は conflict。 */
  create(stay: VisitStay): Promise<RepoResult<VisitStay>>;
  /** 上書き保存（read-modify-write は呼び出し側で行う）。 */
  put(stay: VisitStay): Promise<void>;
}
