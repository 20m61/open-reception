/**
 * 来訪予約の永続化 (#97 increment 3 / #736 Gate A)。
 *
 * ## なぜ必要か
 *
 * 予約は `MemoryReservationRepository`（モジュールスコープの singleton）に載っていた。
 * routing 側は `getBackend()`（DATA_BACKEND=memory|dynamodb）に載っているのに、予約だけが
 * プロセス内のままだった。
 *
 * 🔴 **その結果、本番形態では QR がまったく機能しない。** 管理画面で発行した予約は、
 * 受付端末のリクエストを処理する別の Lambda インスタンスからは見えない。Lambda が
 * 入れ替わるたびに全予約が消える。**発行した QR は必ず「不明な QR」になる。**
 *
 * ## token hash の引き方
 *
 * 受付端末は token を hash して「この hash の予約はどれか」と問う。`list()` 全走査は
 * 読み取り量が全予約数に比例するので、**索引で絞る**（#274/#284 と同じ方針）。
 *
 * 索引の値は `tenantId#siteId#tokenHash`。境界をキーそのものに畳み込むので、
 * 他テナントの予約は**索引の時点で**引けない。
 *
 * 🔴 **索引で絞ったあとも timing-safe 比較を残す。** 索引は読み取り量を減らすためのもので、
 * 照合の性質（`reservationTokenHashesEqual`）を置き換えるものではない。
 *
 * ただし正直に書いておくと、**この比較は振る舞いで観測できない**（索引が正しく効いている
 * 限り、返る候補は必ず一致する）。外すテストを当てても赤くならないことを実測した。
 * 残しているのは索引が陳腐化・衝突したときの多層防御としてで、**「テストで守られている」
 * とは主張しない**。
 */
import { getBackend } from '@/lib/data';
import type { Collection } from '@/lib/data/backend';
import type { SiteId, TenantId } from '@/domain/tenant/types';
import { reservationTokenHashesEqual } from '@/domain/reservation/token';
import type {
  ReservationId,
  ReservationTokenHash,
  VisitReservation,
} from '@/domain/reservation/types';
import type { RepoResult, ReservationRepository } from './repository';

export const RESERVATION_COLLECTION = 'visit_reservation';

/** 一覧上限（#274）。予約はサイトあたりの来訪数に比例して増えるので明示する。 */
const LIST_LIMIT = 1000;

/**
 * 保存形。`scopedTokenHash` は**索引専用の派生値**で、ドメイン型には持たせない
 * （`VisitReservation` を汚さない）。読み出し時に落とす。
 */
type StoredReservation = VisitReservation & { readonly id: string; readonly scopedTokenHash: string };

/** 索引キー。境界をキーへ畳み込み、他テナントの予約を索引の時点で引けなくする。 */
function scopedTokenHash(
  tenantId: string,
  siteId: string,
  tokenHash: ReservationTokenHash,
): string {
  return `${tenantId}#${siteId}#${String(tokenHash)}`;
}

function toStored(reservation: VisitReservation): StoredReservation {
  return {
    ...reservation,
    id: reservation.id,
    scopedTokenHash: scopedTokenHash(reservation.tenantId, reservation.siteId, reservation.tokenHash),
  };
}

function toDomain(stored: StoredReservation): VisitReservation {
  const { scopedTokenHash: _index, ...reservation } = stored;
  return reservation;
}

function inBounds(r: VisitReservation, tenantId: TenantId, siteId: SiteId): boolean {
  return r.tenantId === tenantId && r.siteId === siteId;
}

export class DataBackedReservationRepository implements ReservationRepository {
  private readonly col: () => Collection<StoredReservation>;

  constructor() {
    this.col = () =>
      getBackend().collection<StoredReservation>(RESERVATION_COLLECTION, {
        // 🔴 索引対象は**不変**な派生値。可変フィールドを指定すると `updateIf` で索引が古くなる
        //（`backend.ts` の注記）。token hash と境界は予約の生涯で変わらない。
        indexedField: 'scopedTokenHash',
      });
  }

  async list(tenantId: TenantId, siteId: SiteId): Promise<VisitReservation[]> {
    const all = await this.col().list({ limit: LIST_LIMIT });
    return all.filter((r) => inBounds(r, tenantId, siteId)).map(toDomain);
  }

  async get(
    tenantId: TenantId,
    siteId: SiteId,
    id: ReservationId,
  ): Promise<VisitReservation | undefined> {
    const found = await this.col().get(String(id));
    return found && inBounds(found, tenantId, siteId) ? toDomain(found) : undefined;
  }

  async findByTokenHash(
    tenantId: TenantId,
    siteId: SiteId,
    tokenHash: ReservationTokenHash,
  ): Promise<VisitReservation | undefined> {
    const candidates = await this.col().listByIndex(
      scopedTokenHash(String(tenantId), String(siteId), tokenHash),
      { limit: LIST_LIMIT },
    );
    for (const candidate of candidates) {
      // 索引は読み取り量を減らすためのもの。照合の性質は timing-safe 比較が持つ。
      if (reservationTokenHashesEqual(candidate.tokenHash, tokenHash) && inBounds(candidate, tenantId, siteId)) {
        return toDomain(candidate);
      }
    }
    return undefined;
  }

  async create(reservation: VisitReservation): Promise<RepoResult<VisitReservation>> {
    const existing = await this.col().get(String(reservation.id));
    if (existing !== undefined) {
      return { ok: false, error: { code: 'conflict', message: 'reservation id exists' } };
    }
    await this.col().put(toStored(reservation));
    return { ok: true, value: reservation };
  }

  async put(reservation: VisitReservation): Promise<void> {
    await this.col().put(toStored(reservation));
  }
}
