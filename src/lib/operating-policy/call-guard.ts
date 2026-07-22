/**
 * 営業時間外の新規発信拒否ガード (issue #367 / #4)。
 *
 * `/api/kiosk/receptions/:id/call` の入口で使う。closed 判定のときのみ拒否し、
 * 判定不能（ポリシー未設定・ストア障害）は fail-open（許可）を維持する。
 */
import type { TenantId, SiteId } from '@/domain/tenant/types';
import { resolveKioskStatusFor } from './store';

export type CallGuardResult =
  | { allowed: true }
  | { allowed: false; reason: 'out_of_hours'; reopenAt?: string };

export async function evaluateCallGuard(
  tenantId: TenantId,
  siteId: SiteId,
  now: Date = new Date(),
): Promise<CallGuardResult> {
  try {
    const status = await resolveKioskStatusFor(String(tenantId), String(siteId), now.getTime());
    if (status?.state === 'closed') {
      return { allowed: false, reason: 'out_of_hours', ...(status.reopenAt ? { reopenAt: status.reopenAt } : {}) };
    }
    return { allowed: true };
  } catch {
    return { allowed: true }; // fail-open
  }
}
