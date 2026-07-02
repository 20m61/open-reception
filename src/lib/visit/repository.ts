/**
 * 滞在記録リポジトリ (issue #102 → #274 ① で §9 標準へ統合)。
 *
 * §9.2（docs/persistence-design.md）の標準イディオム: ドメイン語彙の interface +
 * getBackend()（DATA_BACKEND=memory|dynamodb）の Collection に委譲する実装を 1 つだけ持つ
 * （旧 memory-repository.ts / backend-repository.ts の二重実装は廃止。テストは memory
 * backend + seed で本実装を直接検証する）。
 *
 * テナント境界の強制:
 *   - すべての参照系は tenantId/siteId を必須にし、他テナント/他サイトの滞在を返さない。
 *   - 認可判定そのものは呼び出し側が src/domain/tenant/authorization.ts の純関数で行う。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { StayId, VisitStay } from '@/domain/visit/types';
import { getBackend } from '@/lib/data';
import type { Collection } from '@/lib/data/backend';

export type RepoError = { code: 'not_found' | 'conflict' | 'invalid_input'; message: string };
export type RepoResult<T> = { ok: true; value: T } | { ok: false; error: RepoError };

export const VISITSTAY_COLLECTION = 'visitstay';

/**
 * 滞在記録一覧の上限（#274 inc1）。滞在記録は日々増加するため明示する。超過分は list() が
 * warn つきで切り詰める。恒久対応は siteId/status の境界付きクエリ（GSI）への移行
 * （docs/checkout-stay-design.md §6 / #284 と統合設計）。
 */
export const STAY_LIST_LIMIT = 1000;

export interface StayRepository {
  /** 指定サイト配下の滞在のみ返す（テナント/サイト境界）。 */
  list(tenantId: TenantId, siteId: SiteId): Promise<VisitStay[]>;
  /** 指定サイト配下の在館中（present）のみ返す（#274 ①: 受付端末の在館一覧用）。 */
  listPresent(tenantId: TenantId, siteId: SiteId): Promise<VisitStay[]>;
  /** id 取得。tenantId/siteId が一致しない場合は undefined（越境を返さない）。 */
  get(tenantId: TenantId, siteId: SiteId, id: StayId): Promise<VisitStay | undefined>;
  /** 新規作成。id 重複は conflict。 */
  create(stay: VisitStay): Promise<RepoResult<VisitStay>>;
  /** 上書き保存（read-modify-write は呼び出し側で行う）。 */
  put(stay: VisitStay): Promise<void>;
  /** テスト用: seed 状態へ戻す（memory backend のみ実効）。 */
  reset(): Promise<void>;
}

function inBounds(s: VisitStay, tenantId: TenantId, siteId: SiteId): boolean {
  return s.tenantId === tenantId && s.siteId === siteId;
}

/**
 * getBackend() に永続化する滞在記録リポジトリ。Collection は id 単位の汎用ストアのため、
 * テナント/サイト境界はここで適用する（越境を返さない）。dynamo 増分では GSI/Query 最適化を
 * 入れる（docs/checkout-stay-design.md §6）。
 * seed は memory backend のみ有効（dev/test/CI）。dynamodb では無視され実データを正とする。
 */
export class DataBackedStayRepository implements StayRepository {
  private readonly col: () => Collection<VisitStay>;

  constructor(seed?: () => VisitStay[]) {
    this.col = () => getBackend().collection<VisitStay>(VISITSTAY_COLLECTION, { seed });
  }

  async list(tenantId: TenantId, siteId: SiteId): Promise<VisitStay[]> {
    return (await this.col().list({ limit: STAY_LIST_LIMIT })).filter((s) =>
      inBounds(s, tenantId, siteId),
    );
  }

  async listPresent(tenantId: TenantId, siteId: SiteId): Promise<VisitStay[]> {
    return (await this.list(tenantId, siteId)).filter((s) => s.status === 'present');
  }

  async get(tenantId: TenantId, siteId: SiteId, id: StayId): Promise<VisitStay | undefined> {
    const found = await this.col().get(id);
    return found && inBounds(found, tenantId, siteId) ? found : undefined;
  }

  async create(stay: VisitStay): Promise<RepoResult<VisitStay>> {
    const col = this.col();
    const existing = await col.get(stay.id);
    if (existing) return { ok: false, error: { code: 'conflict', message: 'stay id exists' } };
    await col.put(stay);
    return { ok: true, value: stay };
  }

  async put(stay: VisitStay): Promise<void> {
    await this.col().put(stay);
  }

  async reset(): Promise<void> {
    await this.col().reset();
  }
}
