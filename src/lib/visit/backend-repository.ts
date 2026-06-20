/**
 * 滞在記録リポジトリの getBackend ベース実装 (issue #102, increment 1)。
 *
 * 永続化は data backend（memory / dynamodb）に委譲する (docs/persistence-design.md)。
 * Collection は id 単位の汎用ストアのため、テナント/サイト境界はここで適用する
 * （越境を返さない）。dynamo 増分では GSI/Query 最適化を入れる（docs/checkout-stay-design.md §6）。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { StayId, VisitStay } from '@/domain/visit/types';
import { getBackend } from '@/lib/data';
import type { RepoResult, StayRepository } from './repository';

const COLLECTION = 'visitstay';

const stays = () => getBackend().collection<VisitStay>(COLLECTION);

function inBounds(s: VisitStay, tenantId: TenantId, siteId: SiteId): boolean {
  return s.tenantId === tenantId && s.siteId === siteId;
}

export class BackendStayRepository implements StayRepository {
  async list(tenantId: TenantId, siteId: SiteId): Promise<VisitStay[]> {
    return (await stays().list()).filter((s) => inBounds(s, tenantId, siteId));
  }

  async get(tenantId: TenantId, siteId: SiteId, id: StayId): Promise<VisitStay | undefined> {
    const found = await stays().get(id);
    return found && inBounds(found, tenantId, siteId) ? found : undefined;
  }

  async create(stay: VisitStay): Promise<RepoResult<VisitStay>> {
    const existing = await stays().get(stay.id);
    if (existing) return { ok: false, error: { code: 'conflict', message: 'stay id exists' } };
    await stays().put(stay);
    return { ok: true, value: stay };
  }

  async put(stay: VisitStay): Promise<void> {
    await stays().put(stay);
  }
}

/** テスト用: backend のコレクションを seed 状態へ戻す。 */
export async function __resetStayCollection(): Promise<void> {
  await stays().reset();
}
