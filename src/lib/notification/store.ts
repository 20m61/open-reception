/**
 * 通知ルートストア / CallRouteService の組み立て (issue #88, increment 1)。
 *
 * route から使う CallRouteService を 1 つ生成して共有する。本増分の永続化は
 * in-memory（dev/test/CI）。DynamoDB 実装と getBackend() 接続は次増分
 * （docs/call-route-config-design.md §increment 計画）。
 *
 * dev seed は単一テナント運用の互換に合わせ、既存テナント基盤シード
 * （src/lib/tenant/store.ts の internal / default-site）に紐づくルートを 1 件投入する。
 *
 * 監査は既存 appendAdminAudit（src/lib/mock-backend/reception-log-store）を使い、
 * actor=admin・PII なしで記録する（事前定義済み call_route.* アクションを参照）。
 */
import { appendAdminAudit } from '@/lib/mock-backend/reception-log-store';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import { CallRouteService } from './call-route-service';
import { MemoryCallRouteRepository } from './repository';
import { asCallRouteId, type CallRoute } from './types';

/** 既存テナント基盤シード（internal / default-site）に紐づく初期ルート。 */
const SEED_ROUTES: CallRoute[] = [
  {
    id: asCallRouteId('route-seed-1'),
    tenantId: asTenantId('internal'),
    siteId: asSiteId('default-site'),
    name: '本社受付 標準ルート',
    groups: [
      {
        label: '総務グループ',
        targets: [
          { label: '代表電話', channel: 'phone', value: '+81300000000', priority: 0 },
          { label: '管理者メール', channel: 'email', value: 'reception@example.com', priority: 1 },
        ],
      },
    ],
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

let repository: MemoryCallRouteRepository | undefined;
let service: CallRouteService | undefined;

export function getCallRouteService(): CallRouteService {
  if (!service) {
    repository = new MemoryCallRouteRepository(SEED_ROUTES);
    service = new CallRouteService({ routes: repository, appendAudit: appendAdminAudit });
  }
  return service;
}

/** テスト用: ストア（と in-memory データ）を破棄する。 */
export function __resetCallRouteStore(): void {
  repository = undefined;
  service = undefined;
}
