/**
 * ルーティングストア / RoutingService の組み立て (issue #374, 残 increment)。
 *
 * route から使う RoutingService を 1 つ生成して共有する。永続化は getBackend()
 * （DATA_BACKEND=memory|dynamodb）に委譲する DataBacked リポジトリ。
 *
 * dev seed は memory backend のみ有効（dynamodb では無視され実データを正とする）。既定テナント
 * （internal / default-site）に「個人携帯→代理→部門代表」の標準取次（`domain/routing/seed`）を
 * 投入する。管理 UI が無くても seed を土台に運用・検証できる。
 *
 * 監査は既存 appendAdminAudit（src/lib/data-stores/reception-log-store）を使い、actor=admin・
 * PII なしで記録する（第3wave で追加済みの contact_endpoint.* / routing_policy.* を参照）。
 */
import { appendAdminAudit } from '@/lib/data-stores/reception-log-store';
import { buildSeedRoutingPolicy } from '@/domain/routing/seed';
import {
  DataBackedContactEndpointRepository,
  DataBackedRoutingPolicyRepository,
} from './repository';
import { RoutingService } from './service';
import type { StoredContactEndpoint, StoredRoutingPolicy } from './types';

const SEED_TS = '2026-01-01T00:00:00.000Z';

/** 既定テナント（internal / default-site）向けの標準取次 seed（アドレスはダミー番号）。 */
function buildSeed(): { endpoints: StoredContactEndpoint[]; policies: StoredRoutingPolicy[] } {
  const { endpoints, policy } = buildSeedRoutingPolicy({
    tenantId: 'internal',
    siteId: 'default-site',
    providerKey: 'vonage',
    personalMobile: { endpointId: 'seed-ep-personal', ownerId: 'staff-seed', e164: '+81900000001', label: '担当者 個人携帯' },
    actingContact: { endpointId: 'seed-ep-acting', ownerId: 'staff-acting', e164: '+81900000002', label: '代理担当' },
    departmentRepresentative: {
      endpointId: 'seed-ep-department',
      ownerId: 'org-dept',
      e164: '+81300000000',
      label: '部門代表',
    },
  });
  return {
    endpoints: endpoints.map((e) => ({
      ...e,
      tenantId: 'internal',
      siteId: 'default-site',
      createdAt: SEED_TS,
      updatedAt: SEED_TS,
    })),
    policies: [{ ...policy, createdAt: SEED_TS, updatedAt: SEED_TS }],
  };
}

function seedEndpoints(): StoredContactEndpoint[] {
  if (process.env.RECEPTION_DISABLE_DEV_SEED === '1') return [];
  return buildSeed().endpoints;
}

function seedPolicies(): StoredRoutingPolicy[] {
  if (process.env.RECEPTION_DISABLE_DEV_SEED === '1') return [];
  return buildSeed().policies;
}

let service: RoutingService | undefined;

export function getRoutingService(): RoutingService {
  if (!service) {
    service = new RoutingService({
      endpoints: new DataBackedContactEndpointRepository(seedEndpoints),
      policies: new DataBackedRoutingPolicyRepository(seedPolicies),
      appendAudit: appendAdminAudit,
    });
  }
  return service;
}

/** テスト用: サービスを破棄する（次回 getRoutingService で再生成）。 */
export function __resetRoutingService(): void {
  service = undefined;
}
