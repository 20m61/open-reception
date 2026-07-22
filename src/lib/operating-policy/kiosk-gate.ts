/**
 * kiosk 向け営業状態の解決ヘルパ (issue #367)。`maintenance-gate.ts`（#290 item3）と同じ方針:
 * kioskId → Device（tenant/site）解決 → 判定、判定不能/端末未解決時は fail-open（undefined）。
 *
 * `kioskId` は Device.id と一致する（`maintenance-gate.ts` と同じ前提。device-fleet #87）。
 * 未解決（未登録端末・kioskId 未指定・ストア障害）は既定スコープ（`resolveDefaultScope`,
 * 単一テナント運用の MVP 前提）へフォールバックする — kiosk config は「その kioskId 固有の
 * 営業状態が欲しい」経路なので、メンテナンスのように「対象外として無視」ではなく、単一テナント
 * 運用で意味のある既定値を返す方が実用的なため（#367 MVP 制約: Site—RealtimeRuntimeStack 1対1）。
 */
import { asDeviceId } from '@/domain/tenant/types';
import type { KioskOperatingStatus } from '@/domain/kiosk/operating-status';
import { getTenantStore } from '@/lib/tenant/store';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';
import { resolveKioskStatusFor } from './store';

async function resolveScopeForKiosk(kioskId: string): Promise<{ tenantId: string; siteId: string }> {
  const trimmed = kioskId.trim();
  if (trimmed) {
    try {
      const device = await getTenantStore().devices.findDeviceById(asDeviceId(trimmed));
      if (device) return { tenantId: String(device.tenantId), siteId: String(device.siteId) };
    } catch {
      // フォールスルーして既定スコープへ。
    }
  }
  const scope = resolveDefaultScope();
  return { tenantId: String(scope.tenantId), siteId: String(scope.siteId) };
}

/**
 * kioskId に対する現在の営業状態を解決する。判定不能（端末解決失敗・ストア障害）は
 * undefined（fail-open。`operatingStateOf` が「判定不能」として通常受付に倒す）。
 */
export async function resolveKioskOperatingStatusById(
  kioskId: string,
  now: Date = new Date(),
): Promise<KioskOperatingStatus | undefined> {
  try {
    const scope = await resolveScopeForKiosk(kioskId);
    return await resolveKioskStatusFor(scope.tenantId, scope.siteId, now.getTime());
  } catch {
    return undefined;
  }
}
