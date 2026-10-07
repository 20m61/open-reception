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
 *
 * ## 保存期間（#1022）
 *
 * 予約には来訪者の氏名・会社名・メモ（PII）が載る。来訪の終わり（`visitAt` と `expiresAt` の
 * 遅い方）から `retentionDays` 日で破棄する（規則は `@/domain/reservation/retention`）。
 *
 * - **書き込み時**: DynamoDB TTL 属性 `ttl`（epoch 秒）を期限から計算して載せる。編集・再発行で
 *   `visitAt` / `expiresAt` / `retentionDays` が変わっても、`put` のたびに計算し直す。
 *   期限を計算できない予約は書かずに投げる（`ReservationRetentionUncomputableError`）。
 * - **読み取り時**: 期限を過ぎたレコードは `list` / `get` / `findByTokenHash` のどれからも
 *   返さない。DynamoDB の TTL 削除は遅延する（最大で 48 時間程度）ので、TTL だけでは期限後も
 *   読めてしまう。判定は業務フィールドから毎回計算するので、`ttl` 属性を持たない旧レコードも
 *   同じ規則で扱われる（旧レコードへの `ttl` の後付け = 本番データ操作は本変更の範囲外）。
 */
import { getBackend } from '@/lib/data';
import type { Collection, DataBackend } from '@/lib/data/backend';
import type { SiteId, TenantId } from '@/domain/tenant/types';
import { reservationTokenHashesEqual } from '@/domain/reservation/token';
import { isReservationRetainedAt, reservationTtlSeconds } from '@/domain/reservation/retention';
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
 *
 * `ttl` は DynamoDB TTL 属性（epoch 秒・#1022）。**任意**で、本変更より前に書かれた旧レコードは
 * 持たない。読み取り側はこの値を使わず業務フィールドから期限を計算するので、無くても読める。
 */
type StoredReservation = VisitReservation & {
  readonly id: string;
  readonly scopedTokenHash: string;
  readonly ttl?: number;
};

/** 索引キー。境界をキーへ畳み込み、他テナントの予約を索引の時点で引けなくする。 */
function scopedTokenHash(
  tenantId: string,
  siteId: string,
  tokenHash: ReservationTokenHash,
): string {
  return `${tenantId}#${siteId}#${String(tokenHash)}`;
}

/**
 * 期限を計算できない予約は書かない（#1022）。読み取り側はその予約を保持しない（どの経路からも
 * 返さない）ので、書けば「読めず、TTL も無く、物理削除されない PII」になる。入力検証
 * （`validateCreateInput` / `applyEdit` / `applyReissue`）が先に弾くので、ここへ来るのは
 * 検証を経ない書き込みだけ。黙って捨てずに投げる（呼び出し側の欠陥を表に出す）。
 */
export class ReservationRetentionUncomputableError extends Error {
  constructor() {
    super('reservation retention deadline cannot be computed; refusing to persist');
    this.name = 'ReservationRetentionUncomputableError';
  }
}

function toStored(reservation: VisitReservation): StoredReservation {
  const ttl = reservationTtlSeconds(reservation);
  if (ttl === undefined) throw new ReservationRetentionUncomputableError();
  return {
    ...reservation,
    id: reservation.id,
    scopedTokenHash: scopedTokenHash(reservation.tenantId, reservation.siteId, reservation.tokenHash),
    ttl,
  };
}

function toDomain(stored: StoredReservation): VisitReservation {
  // dynamo は `ttl` を内部属性として読み出し時に落とすが、memory backend は落とさない。揃える。
  const { scopedTokenHash: _index, ttl: _ttl, ...reservation } = stored;
  return reservation;
}

function inBounds(r: VisitReservation, tenantId: TenantId, siteId: SiteId): boolean {
  return r.tenantId === tenantId && r.siteId === siteId;
}

export type DataBackedReservationRepositoryOptions = {
  /** 既定は `getBackend()`。テストで dynamo 実装（fake DocumentClient）を差し込むために使う。 */
  backend?: () => DataBackend;
  /** 保存期間の判定に使う現在時刻。既定は実時刻。 */
  now?: () => Date;
};

export class DataBackedReservationRepository implements ReservationRepository {
  private readonly col: () => Collection<StoredReservation>;
  private readonly now: () => Date;

  constructor(options: DataBackedReservationRepositoryOptions = {}) {
    const backend = options.backend ?? getBackend;
    this.now = options.now ?? (() => new Date());
    this.col = () =>
      backend().collection<StoredReservation>(RESERVATION_COLLECTION, {
        // 🔴 索引対象は**不変**な派生値。可変フィールドを指定すると `updateIf` で索引が古くなる
        //（`backend.ts` の注記）。token hash と境界は予約の生涯で変わらない。
        indexedField: 'scopedTokenHash',
      });
  }

  /** 保存期間内か（#1022）。期限を過ぎたレコードは TTL 削除を待たずに読み取りから外す。 */
  private retained(r: VisitReservation): boolean {
    return isReservationRetainedAt(r, this.now());
  }

  async list(tenantId: TenantId, siteId: SiteId): Promise<VisitReservation[]> {
    const all = await this.col().list({ limit: LIST_LIMIT });
    return all.filter((r) => inBounds(r, tenantId, siteId) && this.retained(r)).map(toDomain);
  }

  async get(
    tenantId: TenantId,
    siteId: SiteId,
    id: ReservationId,
  ): Promise<VisitReservation | undefined> {
    const found = await this.col().get(String(id));
    return found && inBounds(found, tenantId, siteId) && this.retained(found)
      ? toDomain(found)
      : undefined;
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
      if (
        reservationTokenHashesEqual(candidate.tokenHash, tokenHash) &&
        inBounds(candidate, tenantId, siteId) &&
        this.retained(candidate)
      ) {
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
