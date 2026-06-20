/**
 * 通知ルート設定のリポジトリ interface と in-memory 実装 (issue #88, increment 1)。
 *
 * 保存先非依存の抽象。DynamoDB 実装と getBackend() 配線は次増分
 * （docs/call-route-config-design.md §increment 計画）。本増分は interface と、
 * 単体テスト/dev/CI 用の in-memory 実装を提供する。
 *
 * テナント/サイト境界の強制（他テナントのルートを返さない）はクエリ引数の
 * tenantId/siteId フィルタで成立させ、認可判定そのものは呼び出し側
 * （src/domain/tenant/authorization.ts の純関数）に委ねる責務分離とする
 * （src/lib/tenant/repository.ts と同方針）。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { CallRoute, CallRouteId } from './types';

export type RepoError = { code: 'not_found' | 'conflict' | 'invalid_input'; message: string };
export type RepoResult<T> = { ok: true; value: T } | { ok: false; error: RepoError };

export interface CallRouteRepository {
  /** 指定テナント配下のルートを返す（siteId 指定時はそのサイトに絞る）。 */
  listRoutes(tenantId: TenantId, siteId?: SiteId): Promise<CallRoute[]>;
  getRoute(tenantId: TenantId, id: CallRouteId): Promise<CallRoute | undefined>;
  createRoute(route: CallRoute): Promise<RepoResult<CallRoute>>;
  putRoute(route: CallRoute): Promise<void>;
  deleteRoute(tenantId: TenantId, id: CallRouteId): Promise<RepoResult<void>>;
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

/** in-memory の通知ルートリポジトリ。テストでは seed を渡して状態を構築する。 */
export class MemoryCallRouteRepository implements CallRouteRepository {
  private readonly routes: Map<string, CallRoute>;

  constructor(seed: CallRoute[] = []) {
    this.routes = new Map(seed.map((r) => [r.id, clone(r)]));
  }

  async listRoutes(tenantId: TenantId, siteId?: SiteId): Promise<CallRoute[]> {
    return [...this.routes.values()]
      .filter((r) => r.tenantId === tenantId && (siteId === undefined || r.siteId === siteId))
      .map(clone);
  }

  async getRoute(tenantId: TenantId, id: CallRouteId): Promise<CallRoute | undefined> {
    const r = this.routes.get(id);
    return r && r.tenantId === tenantId ? clone(r) : undefined;
  }

  async createRoute(route: CallRoute): Promise<RepoResult<CallRoute>> {
    if (this.routes.has(route.id))
      return { ok: false, error: { code: 'conflict', message: 'call route id exists' } };
    this.routes.set(route.id, clone(route));
    return { ok: true, value: clone(route) };
  }

  async putRoute(route: CallRoute): Promise<void> {
    this.routes.set(route.id, clone(route));
  }

  async deleteRoute(tenantId: TenantId, id: CallRouteId): Promise<RepoResult<void>> {
    const r = this.routes.get(id);
    if (!r || r.tenantId !== tenantId)
      return { ok: false, error: { code: 'not_found', message: 'call route not found' } };
    this.routes.delete(id);
    return { ok: true, value: undefined };
  }
}
