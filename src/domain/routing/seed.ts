/**
 * 標準取次ルート（個人携帯 → 代理担当 → 部門代表）の seed (issue #374)。
 *
 * issue の代表シナリオ「個人携帯→代理→部門代表の順次取次」を、そのまま実行できる
 * ContactEndpoint 群 + RoutingPolicy として組み立てる純関数。管理 UI が無い段階でも
 * seed を土台に運用・検証できる（文章形式ルートビルダー UI は残 increment）。
 *
 * 既定の遷移（`policy.ts` の nextTransition）に従い、各手が busy/no_answer/declined/failed の
 * いずれでも次の手へ進み、部門代表で撃ち止め（最後は fallback 無しで stop）。
 */
import type { ContactEndpoint } from './endpoint';
import type { RoutingPolicy } from './policy';

/** seed 対象 1 つ分の接続先指定。アドレスは E.164（機微値）。 */
export type SeedEndpointSpec = {
  endpointId: string;
  /** ownerId（担当者 id / 組織 id）。 */
  ownerId: string;
  /** E.164 電話番号。 */
  e164: string;
  /** 表示ラベル（PII を含めない）。 */
  label: string;
};

export type SeedRouteParams = {
  tenantId: string;
  siteId?: string;
  /** 接続 Provider 識別子（例: 'vonage'）。受付ドメインは中身を解釈しない。 */
  providerKey: string;
  policyId?: string;
  policyName?: string;
  /** 本人の個人携帯。 */
  personalMobile: SeedEndpointSpec;
  /** 代理担当の連絡先。 */
  actingContact: SeedEndpointSpec;
  /** 部門代表の連絡先。 */
  departmentRepresentative: SeedEndpointSpec;
};

export type SeedRoute = {
  endpoints: ContactEndpoint[];
  policy: RoutingPolicy;
};

/** 個人携帯 → 代理担当 → 部門代表の標準ルートを組み立てる。 */
export function buildSeedRoutingPolicy(params: SeedRouteParams): SeedRoute {
  const { providerKey } = params;

  const personal: ContactEndpoint = {
    id: params.personalMobile.endpointId,
    ownerType: 'staff',
    ownerId: params.personalMobile.ownerId,
    channel: 'pstn',
    e164: params.personalMobile.e164,
    providerKey,
    enabled: true,
    label: params.personalMobile.label,
  };
  const acting: ContactEndpoint = {
    id: params.actingContact.endpointId,
    ownerType: 'staff',
    ownerId: params.actingContact.ownerId,
    channel: 'pstn',
    e164: params.actingContact.e164,
    providerKey,
    enabled: true,
    label: params.actingContact.label,
  };
  const department: ContactEndpoint = {
    id: params.departmentRepresentative.endpointId,
    ownerType: 'organization',
    ownerId: params.departmentRepresentative.ownerId,
    channel: 'pstn',
    e164: params.departmentRepresentative.e164,
    providerKey,
    enabled: true,
    label: params.departmentRepresentative.label,
  };

  const policy: RoutingPolicy = {
    id: params.policyId ?? 'seed-personal-acting-department',
    tenantId: params.tenantId,
    siteId: params.siteId,
    name: params.policyName ?? '個人携帯→代理→部門代表',
    enabled: true,
    steps: [
      {
        id: 'personal',
        endpointId: personal.id,
        action: 'notify',
        timeoutSeconds: 20,
        nextOn: {},
      },
      {
        id: 'acting',
        endpointId: acting.id,
        action: 'notify',
        timeoutSeconds: 20,
        nextOn: {},
      },
      {
        id: 'department',
        endpointId: department.id,
        action: 'announce_and_bridge',
        timeoutSeconds: 30,
        nextOn: {},
      },
    ],
  };

  return { endpoints: [personal, acting, department], policy };
}
