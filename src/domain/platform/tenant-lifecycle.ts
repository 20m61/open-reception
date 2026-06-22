/**
 * テナントのライフサイクル操作（有効化/停止）の純ドメイン (issue #90)。
 *
 * プラットフォーム運用者（developer）がテナントを一時停止/再有効化する破壊的操作の、
 * アクション種別 → 状態 / 監査アクション への写像を純関数で定義する。永続化・認可・監査は
 * 外側（platform API）が担う。
 */
import type { AuditAction } from '@/domain/reception/log';
import type { TenantStatus } from '@/domain/tenant/types';

export const TENANT_LIFECYCLE_ACTIONS = ['suspend', 'activate'] as const;
export type TenantLifecycleAction = (typeof TENANT_LIFECYCLE_ACTIONS)[number];

export function isTenantLifecycleAction(value: unknown): value is TenantLifecycleAction {
  return value === 'suspend' || value === 'activate';
}

/** アクション適用後のテナント状態。 */
export function statusForLifecycleAction(action: TenantLifecycleAction): TenantStatus {
  return action === 'suspend' ? 'suspended' : 'active';
}

/** アクションに対応する監査アクション（理由は呼び出し側が metadata.reason に残す）。 */
export function auditActionForLifecycle(
  action: TenantLifecycleAction,
): Extract<AuditAction, 'tenant.suspended' | 'tenant.activated'> {
  return action === 'suspend' ? 'tenant.suspended' : 'tenant.activated';
}
