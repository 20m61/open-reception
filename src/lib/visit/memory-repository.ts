/**
 * 滞在記録リポジトリの in-memory 実装 (issue #102, increment 1)。
 *
 * 単体テスト用。プロセス内 Map で保持する。dev/CI/本番は getBackend ベースの
 * backend-repository.ts を使う（store.ts で組み立て）。
 *
 * テナント/サイト境界は参照時に tenantId/siteId でフィルタして成立させる。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { StayId, VisitStay } from '@/domain/visit/types';
import type { RepoResult, StayRepository } from './repository';

function clone<T>(v: T): T {
  return structuredClone(v);
}

function inBounds(s: VisitStay, tenantId: TenantId, siteId: SiteId): boolean {
  return s.tenantId === tenantId && s.siteId === siteId;
}

export class MemoryStayRepository implements StayRepository {
  private readonly stays: Map<string, VisitStay>;

  constructor(seed?: VisitStay[]) {
    this.stays = new Map((seed ?? []).map((s) => [s.id, clone(s)]));
  }

  async list(tenantId: TenantId, siteId: SiteId): Promise<VisitStay[]> {
    return [...this.stays.values()].filter((s) => inBounds(s, tenantId, siteId)).map(clone);
  }

  async get(tenantId: TenantId, siteId: SiteId, id: StayId): Promise<VisitStay | undefined> {
    const s = this.stays.get(id);
    return s && inBounds(s, tenantId, siteId) ? clone(s) : undefined;
  }

  async create(stay: VisitStay): Promise<RepoResult<VisitStay>> {
    if (this.stays.has(stay.id))
      return { ok: false, error: { code: 'conflict', message: 'stay id exists' } };
    this.stays.set(stay.id, clone(stay));
    return { ok: true, value: clone(stay) };
  }

  async put(stay: VisitStay): Promise<void> {
    this.stays.set(stay.id, clone(stay));
  }
}
