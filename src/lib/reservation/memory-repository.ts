/**
 * 来訪予約リポジトリの in-memory 実装 (issue #97, increment 1)。
 *
 * 単体テストと dev/CI 用。プロセス内 Map で保持する。
 * 本番（DynamoDB シングルテーブル）実装は次増分（docs/visit-reservation-design.md）。
 *
 * テナント/サイト境界は参照時に tenantId/siteId でフィルタして成立させる。
 * 認可判定そのものは呼び出し側（src/domain/tenant/authorization.ts）の責務。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type {
  ReservationId,
  ReservationToken,
  VisitReservation,
} from '@/domain/reservation/types';
import type { ReservationRepository, RepoResult } from './repository';

function clone<T>(v: T): T {
  return structuredClone(v);
}

function inBounds(r: VisitReservation, tenantId: TenantId, siteId: SiteId): boolean {
  return r.tenantId === tenantId && r.siteId === siteId;
}

export class MemoryReservationRepository implements ReservationRepository {
  private readonly reservations: Map<string, VisitReservation>;

  constructor(seed?: VisitReservation[]) {
    this.reservations = new Map((seed ?? []).map((r) => [r.id, clone(r)]));
  }

  async list(tenantId: TenantId, siteId: SiteId): Promise<VisitReservation[]> {
    return [...this.reservations.values()].filter((r) => inBounds(r, tenantId, siteId)).map(clone);
  }

  async get(
    tenantId: TenantId,
    siteId: SiteId,
    id: ReservationId,
  ): Promise<VisitReservation | undefined> {
    const r = this.reservations.get(id);
    return r && inBounds(r, tenantId, siteId) ? clone(r) : undefined;
  }

  async findByToken(
    tenantId: TenantId,
    siteId: SiteId,
    token: ReservationToken,
  ): Promise<VisitReservation | undefined> {
    for (const r of this.reservations.values()) {
      if (r.token === token && inBounds(r, tenantId, siteId)) return clone(r);
    }
    return undefined;
  }

  async create(reservation: VisitReservation): Promise<RepoResult<VisitReservation>> {
    if (this.reservations.has(reservation.id))
      return { ok: false, error: { code: 'conflict', message: 'reservation id exists' } };
    this.reservations.set(reservation.id, clone(reservation));
    return { ok: true, value: clone(reservation) };
  }

  async put(reservation: VisitReservation): Promise<void> {
    this.reservations.set(reservation.id, clone(reservation));
  }
}
