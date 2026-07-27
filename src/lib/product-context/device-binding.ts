/**
 * kioskId からテナント/拠点の束縛を解決する (issue #419)。
 *
 * 既存の `lib/operating-policy/kiosk-gate.ts` / `lib/platform/maintenance-gate.ts` は同じ解決を
 * **fail-open**（未解決なら既定スコープ）で行う。営業状態やメンテナンス表示は「判定できなければ
 * 通常受付に倒す」のが正しいためだが、**構成配信で同じことをすると、未登録の端末に既定テナントの
 * 構成が配られる**。ここは fail-closed（未解決・失効は null）にする。
 *
 * 3 実装が並存している状態は `docs/product-integration-plan.md` §5 に重複概念として登録済み。
 * 最終的に本モジュールへ寄せ、fail-open が要る呼び出し側は戻り値 null を自分で既定へ倒す。
 */
import type { Actor } from '@/domain/tenant/authorization';
import { asDeviceId, asSiteId, asTenantId, type SiteId, type TenantId } from '@/domain/tenant/types';
import { getTenantStore } from '@/lib/tenant/store';

export type ResolvedDeviceBinding = {
  tenantId: TenantId;
  siteId: SiteId;
  kioskId: string;
};

/** 登録済みかつ有効な端末のみ束縛を返す。未登録・失効・ストア障害は null。 */
export async function resolveDeviceBinding(
  kioskId: string,
): Promise<ResolvedDeviceBinding | null> {
  const trimmed = kioskId.trim();
  if (!trimmed) return null;

  try {
    const device = await getTenantStore().devices.findDeviceById(asDeviceId(trimmed));
    if (!device || device.status !== 'active') return null;
    return {
      tenantId: asTenantId(String(device.tenantId)),
      siteId: asSiteId(String(device.siteId)),
      kioskId: trimmed,
    };
  } catch {
    return null;
  }
}

/**
 * 端末束縛から認可判定用の actor を組む。端末は `kiosk_device` 割り当て 1 件だけを持ち、
 * 管理系の権限は一切持たない（`resolveProductContext` が管理領域で弾く）。
 */
export function deviceActorFor(binding: ResolvedDeviceBinding): Actor {
  return {
    status: 'active',
    assignments: [
      {
        role: 'kiosk_device',
        tenantId: binding.tenantId,
        siteId: binding.siteId,
        deviceId: asDeviceId(binding.kioskId),
      },
    ],
  };
}
