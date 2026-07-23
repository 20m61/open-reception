/**
 * 来訪予約リポジトリの interface (issue #97, increment 1)。
 *
 * 保存先非依存の抽象のみを定義する。DynamoDB シングルテーブル実装は次増分
 * （docs/visit-reservation-design.md §increment 計画）。本増分は interface と、
 * 単体テスト/開発用の in-memory 実装（./memory-repository.ts）を提供する。
 *
 * テナント境界の強制:
 *   - すべての参照系は tenantId/siteId を必須にし、他テナント/他サイトの予約を返さない。
 *   - 認可判定そのものは呼び出し側が src/domain/tenant/authorization.ts の純関数で行う。
 *   - Result/エラー様式は src/lib/tenant/repository.ts に揃える。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type {
  ReservationId,
  ReservationTokenHash,
  VisitReservation,
} from '@/domain/reservation/types';

export type RepoError = { code: 'not_found' | 'conflict' | 'invalid_input'; message: string };
export type RepoResult<T> = { ok: true; value: T } | { ok: false; error: RepoError };

export interface ReservationRepository {
  /** 指定サイト配下の予約のみ返す（テナント/サイト境界）。 */
  list(tenantId: TenantId, siteId: SiteId): Promise<VisitReservation[]>;
  /** id 取得。tenantId/siteId が一致しない場合は undefined（越境を返さない）。 */
  get(tenantId: TenantId, siteId: SiteId, id: ReservationId): Promise<VisitReservation | undefined>;
  /**
   * token hash から予約を引く（受付端末のチェックイン用・#375）。
   * 呼び出し側が入力 token を hash してから渡す（生 token をリポジトリへ渡さない）。
   * 照合は timing-safe 比較で行う。越境防止のためマッチ後に境界一致しなければ undefined。
   */
  findByTokenHash(
    tenantId: TenantId,
    siteId: SiteId,
    tokenHash: ReservationTokenHash,
  ): Promise<VisitReservation | undefined>;
  /** 新規作成。id 重複は conflict。 */
  create(reservation: VisitReservation): Promise<RepoResult<VisitReservation>>;
  /** 上書き保存（read-modify-write は呼び出し側で行う）。 */
  put(reservation: VisitReservation): Promise<void>;
}
