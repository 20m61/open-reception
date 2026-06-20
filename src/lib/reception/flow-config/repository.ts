/**
 * 受付フロー設定リポジトリの interface と実装 (issue #100, increment 1)。
 *
 * 保存先非依存の抽象。getBackend()（DATA_BACKEND=memory|dynamodb）の Collection に委譲する
 * DataBacked 実装（src/lib/tenant/data-repository.ts と同方針）と、単体テスト用の in-memory
 * 実装の両方を提供する。
 *
 * テナント/サイト境界の強制（他テナントのフローを返さない）はクエリ引数の tenantId/siteId
 * フィルタで成立させ、認可判定そのものは呼び出し側（src/domain/tenant/authorization.ts の
 * 純関数）に委ねる責務分離とする。フロー定義は小規模なため list 走査で足りる
 * （PK/SK・GSI 最適化は将来増分）。
 */
import { getBackend } from '@/lib/data';
import type { Collection } from '@/lib/data/backend';
import type { ReceptionFlowId } from '@/domain/reception/custom-flow';
import type { SiteId, TenantId } from '@/domain/tenant/types';
import type { StoredReceptionFlow } from './types';

export const RECEPTION_FLOW_COLLECTION = 'reception_flow';

export type RepoError = { code: 'not_found' | 'conflict' | 'invalid_input'; message: string };
export type RepoResult<T> = { ok: true; value: T } | { ok: false; error: RepoError };

export interface ReceptionFlowRepository {
  /** 指定テナント配下のフローを返す（siteId 指定時はそのサイトに絞る）。 */
  listFlows(tenantId: TenantId, siteId?: SiteId): Promise<StoredReceptionFlow[]>;
  getFlow(tenantId: TenantId, id: ReceptionFlowId): Promise<StoredReceptionFlow | undefined>;
  createFlow(flow: StoredReceptionFlow): Promise<RepoResult<StoredReceptionFlow>>;
  putFlow(flow: StoredReceptionFlow): Promise<void>;
  deleteFlow(tenantId: TenantId, id: ReceptionFlowId): Promise<RepoResult<void>>;
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

/** 同一サイト内で purposeKey が衝突しないか（一意制約は走査で担保）。 */
function hasPurposeConflict(
  all: StoredReceptionFlow[],
  flow: StoredReceptionFlow,
): boolean {
  return all.some(
    (f) =>
      f.id !== flow.id &&
      f.tenantId === flow.tenantId &&
      f.siteId === flow.siteId &&
      f.purposeKey === flow.purposeKey,
  );
}

/**
 * getBackend() に永続化する受付フローリポジトリ。
 * seed は memory backend のみ有効（dev/test/CI）。dynamodb では無視され実データを正とする。
 */
export class DataBackedReceptionFlowRepository implements ReceptionFlowRepository {
  private readonly col: () => Collection<StoredReceptionFlow>;

  constructor(seed?: () => StoredReceptionFlow[]) {
    this.col = () => getBackend().collection<StoredReceptionFlow>(RECEPTION_FLOW_COLLECTION, { seed });
  }

  async listFlows(tenantId: TenantId, siteId?: SiteId): Promise<StoredReceptionFlow[]> {
    const all = await this.col().list();
    return all.filter(
      (f) => f.tenantId === tenantId && (siteId === undefined || f.siteId === siteId),
    );
  }

  async getFlow(tenantId: TenantId, id: ReceptionFlowId): Promise<StoredReceptionFlow | undefined> {
    const f = await this.col().get(id);
    return f && f.tenantId === tenantId ? f : undefined;
  }

  async createFlow(flow: StoredReceptionFlow): Promise<RepoResult<StoredReceptionFlow>> {
    const col = this.col();
    if (await col.get(flow.id))
      return { ok: false, error: { code: 'conflict', message: 'reception flow id exists' } };
    if (hasPurposeConflict(await col.list(), flow))
      return { ok: false, error: { code: 'conflict', message: 'purposeKey already exists for this site' } };
    await col.put(flow);
    return { ok: true, value: clone(flow) };
  }

  async putFlow(flow: StoredReceptionFlow): Promise<void> {
    await this.col().put(flow);
  }

  async deleteFlow(tenantId: TenantId, id: ReceptionFlowId): Promise<RepoResult<void>> {
    const col = this.col();
    const f = await col.get(id);
    if (!f || f.tenantId !== tenantId)
      return { ok: false, error: { code: 'not_found', message: 'reception flow not found' } };
    await col.remove(id);
    return { ok: true, value: undefined };
  }
}

/**
 * in-memory の受付フローリポジトリ。getBackend に依存せず、テストで seed を渡して
 * 状態を構築する（純粋なリポジトリ単体テスト用）。
 */
export class MemoryReceptionFlowRepository implements ReceptionFlowRepository {
  private readonly flows: Map<string, StoredReceptionFlow>;

  constructor(seed: StoredReceptionFlow[] = []) {
    this.flows = new Map(seed.map((f) => [f.id, clone(f)]));
  }

  async listFlows(tenantId: TenantId, siteId?: SiteId): Promise<StoredReceptionFlow[]> {
    return [...this.flows.values()]
      .filter((f) => f.tenantId === tenantId && (siteId === undefined || f.siteId === siteId))
      .map(clone);
  }

  async getFlow(tenantId: TenantId, id: ReceptionFlowId): Promise<StoredReceptionFlow | undefined> {
    const f = this.flows.get(id);
    return f && f.tenantId === tenantId ? clone(f) : undefined;
  }

  async createFlow(flow: StoredReceptionFlow): Promise<RepoResult<StoredReceptionFlow>> {
    if (this.flows.has(flow.id))
      return { ok: false, error: { code: 'conflict', message: 'reception flow id exists' } };
    if (hasPurposeConflict([...this.flows.values()], flow))
      return { ok: false, error: { code: 'conflict', message: 'purposeKey already exists for this site' } };
    this.flows.set(flow.id, clone(flow));
    return { ok: true, value: clone(flow) };
  }

  async putFlow(flow: StoredReceptionFlow): Promise<void> {
    this.flows.set(flow.id, clone(flow));
  }

  async deleteFlow(tenantId: TenantId, id: ReceptionFlowId): Promise<RepoResult<void>> {
    const f = this.flows.get(id);
    if (!f || f.tenantId !== tenantId)
      return { ok: false, error: { code: 'not_found', message: 'reception flow not found' } };
    this.flows.delete(id);
    return { ok: true, value: undefined };
  }
}
