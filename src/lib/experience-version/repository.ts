/**
 * 受付体験バージョンの永続化 (issue #420 increment 2)。
 *
 * `src/lib/reception/flow-config/repository.ts` と同方針: 保存先非依存の interface と、
 * `getBackend()`（DATA_BACKEND=memory|dynamodb）の Collection に委譲する実装。
 *
 * 1 拠点 = 1 受付体験（MVP 制約）。版履歴は体験レコードの `versions` 配列に持つ
 * （版は数十件規模で、常に体験ごと丸ごと読むため分割しない）。テナント境界は `tenantId` の
 * indexedField で境界付きクエリにし、認可判定そのものは呼び出し側の純関数に委ねる。
 */
import { getBackend } from '@/lib/data';
import type { Collection } from '@/lib/data/backend';
import type { ReceptionExperience } from '@/domain/experience-version/types';
import type { SiteId, TenantId } from '@/domain/tenant/types';

export const EXPERIENCE_VERSION_COLLECTION = 'reception_experience';

/** 保存レコード。`id` は `<tenantId>:<siteId>`（1 拠点 1 体験）。 */
export type StoredExperience = ReceptionExperience & { id: string };

export function experienceIdFor(tenantId: TenantId, siteId: SiteId): string {
  return `${String(tenantId)}:${String(siteId)}`;
}

export interface ExperienceRepository {
  findBySite(tenantId: TenantId, siteId: SiteId): Promise<StoredExperience | undefined>;
  put(experience: StoredExperience): Promise<void>;
  listByTenant(tenantId: TenantId): Promise<StoredExperience[]>;
}

function collection(): Collection<StoredExperience> {
  return getBackend().collection<StoredExperience>(EXPERIENCE_VERSION_COLLECTION, {
    indexedField: 'tenantId',
  });
}

export class DataBackedExperienceRepository implements ExperienceRepository {
  async findBySite(tenantId: TenantId, siteId: SiteId): Promise<StoredExperience | undefined> {
    const found = await collection().get(experienceIdFor(tenantId, siteId));
    // id は tenant/site から組むが、念のため実データ側の境界も確認する（取り違え防止）。
    if (!found || found.tenantId !== tenantId || found.siteId !== siteId) return undefined;
    return found;
  }

  async put(experience: StoredExperience): Promise<void> {
    await collection().put(experience);
  }

  async listByTenant(tenantId: TenantId): Promise<StoredExperience[]> {
    return collection().listByIndex(String(tenantId));
  }
}

/** 単体テスト用の in-memory 実装。 */
export class InMemoryExperienceRepository implements ExperienceRepository {
  private readonly items = new Map<string, StoredExperience>();

  async findBySite(tenantId: TenantId, siteId: SiteId): Promise<StoredExperience | undefined> {
    const found = this.items.get(experienceIdFor(tenantId, siteId));
    return found ? structuredClone(found) : undefined;
  }

  async put(experience: StoredExperience): Promise<void> {
    this.items.set(experience.id, structuredClone(experience));
  }

  async listByTenant(tenantId: TenantId): Promise<StoredExperience[]> {
    return [...this.items.values()]
      .filter((e) => e.tenantId === tenantId)
      .map((e) => structuredClone(e));
  }
}
