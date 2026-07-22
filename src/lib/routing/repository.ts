/**
 * ルーティング永続化リポジトリの interface と実装 (issue #374, 残 increment)。
 *
 * 保存先非依存の抽象。getBackend()（DATA_BACKEND=memory|dynamodb）の Collection に委譲する
 * DataBacked 実装（`src/lib/reception/flow-config/repository.ts` と同方針）と、単体テスト用の
 * in-memory 実装の両方を提供する。
 *
 * テナント/サイト境界の強制（他テナントのデータを返さない）はクエリ引数の tenantId/siteId
 * フィルタで成立させ、認可判定そのものは呼び出し側（`src/domain/tenant/authorization.ts` の
 * 純関数）へ委ねる責務分離とする。接続先アドレス（e164/uri）は保存はするが、外へ出す責務は
 * service 層（`EndpointView` への変換）に閉じる。
 */
import { getBackend } from '@/lib/data';
import type { Collection } from '@/lib/data/backend';
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { StoredContactEndpoint, StoredRoutingPolicy } from './types';

export const CONTACT_ENDPOINT_COLLECTION = 'routing_endpoint';
export const ROUTING_POLICY_COLLECTION = 'routing_policy';

/** 一覧上限（#274）。接続先・ポリシーは設定系だがテナント×サイト数に比例して増え得るため明示する。 */
const LIST_LIMIT = 1000;

export type RepoError = { code: 'not_found' | 'conflict' | 'invalid_input'; message: string };
export type RepoResult<T> = { ok: true; value: T } | { ok: false; error: RepoError };

function clone<T>(v: T): T {
  return structuredClone(v);
}

export interface ContactEndpointRepository {
  list(tenantId: TenantId, siteId?: SiteId): Promise<StoredContactEndpoint[]>;
  get(tenantId: TenantId, id: string): Promise<StoredContactEndpoint | undefined>;
  create(endpoint: StoredContactEndpoint): Promise<RepoResult<StoredContactEndpoint>>;
  put(endpoint: StoredContactEndpoint): Promise<void>;
  remove(tenantId: TenantId, id: string): Promise<RepoResult<void>>;
}

export interface RoutingPolicyRepository {
  list(tenantId: TenantId, siteId?: SiteId): Promise<StoredRoutingPolicy[]>;
  get(tenantId: TenantId, id: string): Promise<StoredRoutingPolicy | undefined>;
  create(policy: StoredRoutingPolicy): Promise<RepoResult<StoredRoutingPolicy>>;
  put(policy: StoredRoutingPolicy): Promise<void>;
  remove(tenantId: TenantId, id: string): Promise<RepoResult<void>>;
}

function inTenant(tenantId: TenantId, itemTenantId: string): boolean {
  return itemTenantId === String(tenantId);
}

function inSite(siteId: SiteId | undefined, itemSiteId: string | undefined): boolean {
  return siteId === undefined || itemSiteId === String(siteId);
}

/** getBackend() に永続化する接続先リポジトリ。seed は memory backend のみ有効。 */
export class DataBackedContactEndpointRepository implements ContactEndpointRepository {
  private readonly col: () => Collection<StoredContactEndpoint>;

  constructor(seed?: () => StoredContactEndpoint[]) {
    this.col = () => getBackend().collection<StoredContactEndpoint>(CONTACT_ENDPOINT_COLLECTION, { seed });
  }

  async list(tenantId: TenantId, siteId?: SiteId): Promise<StoredContactEndpoint[]> {
    const all = await this.col().list({ limit: LIST_LIMIT });
    return all.filter((e) => inTenant(tenantId, e.tenantId) && inSite(siteId, e.siteId));
  }

  async get(tenantId: TenantId, id: string): Promise<StoredContactEndpoint | undefined> {
    const e = await this.col().get(id);
    return e && inTenant(tenantId, e.tenantId) ? e : undefined;
  }

  async create(endpoint: StoredContactEndpoint): Promise<RepoResult<StoredContactEndpoint>> {
    const col = this.col();
    if (await col.get(endpoint.id))
      return { ok: false, error: { code: 'conflict', message: 'endpoint id exists' } };
    await col.put(endpoint);
    return { ok: true, value: clone(endpoint) };
  }

  async put(endpoint: StoredContactEndpoint): Promise<void> {
    await this.col().put(endpoint);
  }

  async remove(tenantId: TenantId, id: string): Promise<RepoResult<void>> {
    const col = this.col();
    const e = await col.get(id);
    if (!e || !inTenant(tenantId, e.tenantId))
      return { ok: false, error: { code: 'not_found', message: 'endpoint not found' } };
    await col.remove(id);
    return { ok: true, value: undefined };
  }
}

/** getBackend() に永続化するポリシーリポジトリ。seed は memory backend のみ有効。 */
export class DataBackedRoutingPolicyRepository implements RoutingPolicyRepository {
  private readonly col: () => Collection<StoredRoutingPolicy>;

  constructor(seed?: () => StoredRoutingPolicy[]) {
    this.col = () => getBackend().collection<StoredRoutingPolicy>(ROUTING_POLICY_COLLECTION, { seed });
  }

  async list(tenantId: TenantId, siteId?: SiteId): Promise<StoredRoutingPolicy[]> {
    const all = await this.col().list({ limit: LIST_LIMIT });
    return all.filter((p) => inTenant(tenantId, p.tenantId) && inSite(siteId, p.siteId));
  }

  async get(tenantId: TenantId, id: string): Promise<StoredRoutingPolicy | undefined> {
    const p = await this.col().get(id);
    return p && inTenant(tenantId, p.tenantId) ? p : undefined;
  }

  async create(policy: StoredRoutingPolicy): Promise<RepoResult<StoredRoutingPolicy>> {
    const col = this.col();
    if (await col.get(policy.id))
      return { ok: false, error: { code: 'conflict', message: 'policy id exists' } };
    await col.put(policy);
    return { ok: true, value: clone(policy) };
  }

  async put(policy: StoredRoutingPolicy): Promise<void> {
    await this.col().put(policy);
  }

  async remove(tenantId: TenantId, id: string): Promise<RepoResult<void>> {
    const col = this.col();
    const p = await col.get(id);
    if (!p || !inTenant(tenantId, p.tenantId))
      return { ok: false, error: { code: 'not_found', message: 'policy not found' } };
    await col.remove(id);
    return { ok: true, value: undefined };
  }
}

/** in-memory の接続先リポジトリ（getBackend 非依存。純粋なリポジトリ単体テスト用）。 */
export class MemoryContactEndpointRepository implements ContactEndpointRepository {
  private readonly items: Map<string, StoredContactEndpoint>;

  constructor(seed: StoredContactEndpoint[] = []) {
    this.items = new Map(seed.map((e) => [e.id, clone(e)]));
  }

  async list(tenantId: TenantId, siteId?: SiteId): Promise<StoredContactEndpoint[]> {
    return [...this.items.values()]
      .filter((e) => inTenant(tenantId, e.tenantId) && inSite(siteId, e.siteId))
      .map(clone);
  }

  async get(tenantId: TenantId, id: string): Promise<StoredContactEndpoint | undefined> {
    const e = this.items.get(id);
    return e && inTenant(tenantId, e.tenantId) ? clone(e) : undefined;
  }

  async create(endpoint: StoredContactEndpoint): Promise<RepoResult<StoredContactEndpoint>> {
    if (this.items.has(endpoint.id))
      return { ok: false, error: { code: 'conflict', message: 'endpoint id exists' } };
    this.items.set(endpoint.id, clone(endpoint));
    return { ok: true, value: clone(endpoint) };
  }

  async put(endpoint: StoredContactEndpoint): Promise<void> {
    this.items.set(endpoint.id, clone(endpoint));
  }

  async remove(tenantId: TenantId, id: string): Promise<RepoResult<void>> {
    const e = this.items.get(id);
    if (!e || !inTenant(tenantId, e.tenantId))
      return { ok: false, error: { code: 'not_found', message: 'endpoint not found' } };
    this.items.delete(id);
    return { ok: true, value: undefined };
  }
}

/** in-memory のポリシーリポジトリ（getBackend 非依存）。 */
export class MemoryRoutingPolicyRepository implements RoutingPolicyRepository {
  private readonly items: Map<string, StoredRoutingPolicy>;

  constructor(seed: StoredRoutingPolicy[] = []) {
    this.items = new Map(seed.map((p) => [p.id, clone(p)]));
  }

  async list(tenantId: TenantId, siteId?: SiteId): Promise<StoredRoutingPolicy[]> {
    return [...this.items.values()]
      .filter((p) => inTenant(tenantId, p.tenantId) && inSite(siteId, p.siteId))
      .map(clone);
  }

  async get(tenantId: TenantId, id: string): Promise<StoredRoutingPolicy | undefined> {
    const p = this.items.get(id);
    return p && inTenant(tenantId, p.tenantId) ? clone(p) : undefined;
  }

  async create(policy: StoredRoutingPolicy): Promise<RepoResult<StoredRoutingPolicy>> {
    if (this.items.has(policy.id))
      return { ok: false, error: { code: 'conflict', message: 'policy id exists' } };
    this.items.set(policy.id, clone(policy));
    return { ok: true, value: clone(policy) };
  }

  async put(policy: StoredRoutingPolicy): Promise<void> {
    this.items.set(policy.id, clone(policy));
  }

  async remove(tenantId: TenantId, id: string): Promise<RepoResult<void>> {
    const p = this.items.get(id);
    if (!p || !inTenant(tenantId, p.tenantId))
      return { ok: false, error: { code: 'not_found', message: 'policy not found' } };
    this.items.delete(id);
    return { ok: true, value: undefined };
  }
}
