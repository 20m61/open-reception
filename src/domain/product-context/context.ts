/**
 * `ProductContext` の権威ある解決 (issue #419)。
 *
 * 「クライアントが送る tenantId をそのまま信用しない」という #80 の原則を、製品全体
 * （platform / admin / プレビュー / 端末）で 1 つの入口に集約する。判定そのものは
 * `src/domain/tenant/authorization.ts`（`canAccessTenant` / `canAccessSite` / `canDeviceAct`）
 * へ委譲し、本モジュールは**領域ごとの権威入力の選び方**だけを定義する:
 *
 *   - `kiosk-runtime`  … 認証済み端末セッションの束縛が権威。query の tenant/site/kiosk は
 *                        照合にのみ使い、食い違えば採用せず「無視した」ことを記録する
 *                        （拒否はしない = 端末の可用性を落とさない。監査の手掛かりは残す）。
 *                        未公開（draft）の受付体験は配信しない。
 *   - `kiosk-preview`  … actor の割り当てと、選択された tenant/site/kiosk を照合する。越境は 403。
 *   - `tenant`         … tenant 必須・site 任意（指定時は境界検証）。
 *   - `platform`       … developer（全テナント横断）のみ。
 *
 * I/O を持たない純関数。セッション・actor の解決は呼び出し側（route / middleware）が行う。
 */
import type { Actor } from '@/domain/tenant/authorization';
import {
  accessibleTenants,
  canAccessSite,
  canAccessTenant,
  canDeviceAct,
} from '@/domain/tenant/authorization';
import {
  asDeviceId,
  asSiteId,
  asTenantId,
  type SiteId,
  type TenantId,
  type TenantRole,
} from '@/domain/tenant/types';
import type {
  ConfigurationVersionSelector,
  ProductArea,
  ProductContext,
  ProductRole,
} from './types';

/** 認証済み端末セッションから得た束縛。`kiosk-runtime` の権威入力。 */
export type DeviceBinding = {
  tenantId: TenantId;
  siteId: SiteId;
  kioskId: string;
};

/** クライアント由来の希望スコープ。信用せず、照合にのみ使う。 */
export type RequestedScope = {
  tenantId?: string;
  siteId?: string;
  kioskId?: string;
};

export type ProductContextInput = {
  /** 監査に残す actor 識別子（端末なら kioskId）。 */
  actorId: string;
  actor: Actor | null;
  area: ProductArea;
  deviceBinding?: DeviceBinding;
  requested?: RequestedScope;
  version?: ConfigurationVersionSelector;
};

export type ContextDenialReason =
  | 'unauthenticated'
  | 'area_not_allowed'
  | 'scope_required'
  | 'cross_tenant'
  | 'cross_site'
  | 'cross_kiosk'
  | 'draft_not_allowed';

export type ProductContextResolution =
  | {
      ok: true;
      value: ProductContext;
      /** クライアントが送ったが採用しなかったスコープキー（端末実行時のみ発生しうる）。 */
      ignoredClientScope: readonly (keyof RequestedScope)[];
    }
  | { ok: false; reason: ContextDenialReason };

/** 拒否理由 → HTTP ステータス。route 実装がばらつかないよう 1 か所で決める。 */
export function contextDenialStatus(reason: ContextDenialReason): 400 | 401 | 403 {
  switch (reason) {
    case 'unauthenticated':
      return 401;
    case 'scope_required':
      return 400;
    default:
      return 403;
  }
}

/** ロールの強さ。同一テナントに複数割り当てがある場合に最も強いものを採用する。 */
const ROLE_RANK: Record<TenantRole, number> = {
  kiosk_device: 0,
  viewer: 1,
  site_manager: 2,
  tenant_admin: 3,
  developer: 4,
};

function isActive(actor: Actor | null | undefined): actor is Actor {
  return !!actor && actor.status === 'active' && actor.assignments.length > 0;
}

function hasDeviceRole(actor: Actor): boolean {
  return actor.assignments.some((a) => a.role === 'kiosk_device');
}

/** 端末割り当てを除いた actor。管理系領域の認可判定に使う。 */
function withoutDeviceAssignments(actor: Actor): Actor {
  if (!hasDeviceRole(actor)) return actor;
  return { ...actor, assignments: actor.assignments.filter((a) => a.role !== 'kiosk_device') };
}

/**
 * 対象スコープに効く最も強いロール。developer は常に採用される。
 * 該当が無ければ null（呼び出し側は既に authorization で許可を確認済みなので通常起きない）。
 */
function strongestRoleFor(
  actor: Actor,
  tenantId: TenantId | undefined,
  siteId: SiteId | undefined,
): ProductRole | null {
  let best: TenantRole | null = null;
  for (const a of actor.assignments) {
    if (a.role !== 'developer') {
      if (tenantId === undefined || a.tenantId !== tenantId) continue;
      if (siteId !== undefined && a.siteId !== null && a.siteId !== siteId) continue;
    }
    if (best === null || ROLE_RANK[a.role] > ROLE_RANK[best]) best = a.role;
  }
  return best;
}

function versionIdOf(selector: ConfigurationVersionSelector | undefined): string | undefined {
  return selector?.kind === 'pinned' ? selector.experienceVersionId : undefined;
}

/** 端末実行コンテキスト: セッション束縛を採用し、クライアント指定は照合のみ。 */
function resolveKioskRuntime(input: ProductContextInput): ProductContextResolution {
  const { actor, deviceBinding } = input;
  if (!isActive(actor) || !deviceBinding) return { ok: false, reason: 'unauthenticated' };
  if (!hasDeviceRole(actor)) return { ok: false, reason: 'cross_kiosk' };
  if (
    !canDeviceAct(
      actor,
      deviceBinding.tenantId,
      deviceBinding.siteId,
      asDeviceId(deviceBinding.kioskId),
    )
  ) {
    return { ok: false, reason: 'cross_kiosk' };
  }
  // 端末へ未公開の受付体験を配信しない（#420 の draft/published 分離を先に契約として固定する）。
  if (input.version?.kind === 'draft') return { ok: false, reason: 'draft_not_allowed' };

  const requested = input.requested ?? {};
  const ignored: (keyof RequestedScope)[] = [];
  if (requested.tenantId !== undefined && requested.tenantId !== deviceBinding.tenantId) {
    ignored.push('tenantId');
  }
  if (requested.siteId !== undefined && requested.siteId !== deviceBinding.siteId) {
    ignored.push('siteId');
  }
  if (requested.kioskId !== undefined && requested.kioskId !== deviceBinding.kioskId) {
    ignored.push('kioskId');
  }

  return {
    ok: true,
    value: {
      actorId: input.actorId,
      role: 'kiosk_device',
      area: 'kiosk-runtime',
      tenantId: deviceBinding.tenantId,
      siteId: deviceBinding.siteId,
      kioskId: deviceBinding.kioskId,
      experienceVersionId: versionIdOf(input.version),
    },
    ignoredClientScope: ignored,
  };
}

/** 管理系コンテキスト（platform / tenant / kiosk-preview）。 */
function resolveManaged(input: ProductContextInput): ProductContextResolution {
  const { area } = input;
  if (!isActive(input.actor)) return { ok: false, reason: 'unauthenticated' };
  // 端末資格は管理系領域では一切効かせない（端末トークンで管理・プレビューの構成を覗かせない）。
  // 割り当てを間引いた actor で以降の認可判定を行い、kiosk_device しか持たない actor は入れない。
  const actor = withoutDeviceAssignments(input.actor);
  if (actor.assignments.length === 0) return { ok: false, reason: 'area_not_allowed' };

  const requested = input.requested ?? {};

  if (area === 'platform') {
    if (accessibleTenants(actor).scope !== 'all') return { ok: false, reason: 'area_not_allowed' };
    return {
      ok: true,
      value: {
        actorId: input.actorId,
        role: 'developer',
        area,
        tenantId: requested.tenantId ? asTenantId(requested.tenantId) : undefined,
        experienceVersionId: versionIdOf(input.version),
      },
      ignoredClientScope: [],
    };
  }

  if (!requested.tenantId) return { ok: false, reason: 'scope_required' };
  if (area === 'kiosk-preview' && (!requested.siteId || !requested.kioskId)) {
    return { ok: false, reason: 'scope_required' };
  }

  const tenantId = asTenantId(requested.tenantId);
  if (!canAccessTenant(actor, tenantId, 'read')) return { ok: false, reason: 'cross_tenant' };

  const siteId = requested.siteId ? asSiteId(requested.siteId) : undefined;
  if (siteId !== undefined && !canAccessSite(actor, tenantId, siteId, 'read')) {
    return { ok: false, reason: 'cross_site' };
  }

  const role = strongestRoleFor(actor, tenantId, siteId);
  if (role === null) return { ok: false, reason: 'cross_tenant' };

  return {
    ok: true,
    value: {
      actorId: input.actorId,
      role,
      area,
      tenantId,
      siteId,
      kioskId: requested.kioskId,
      experienceVersionId: versionIdOf(input.version),
    },
    ignoredClientScope: [],
  };
}

/**
 * 領域ごとの権威入力から `ProductContext` を解決する。
 * 拒否時は理由のみを返す（呼び出し側が `contextDenialStatus` で HTTP に写像する）。
 */
export function resolveProductContext(input: ProductContextInput): ProductContextResolution {
  return input.area === 'kiosk-runtime' ? resolveKioskRuntime(input) : resolveManaged(input);
}
