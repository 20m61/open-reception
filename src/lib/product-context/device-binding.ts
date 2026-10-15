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
import { credentialGenerationOf } from '@/domain/tenant/device-credential';
import { getTenantStore } from '@/lib/tenant/store';

export type ResolvedDeviceBinding = {
  tenantId: TenantId;
  siteId: SiteId;
  kioskId: string;
  /** 端末証明の世代（未設定の旧レコードは 0）。PIN 再認可で証明と突き合わせる (#1237)。 */
  credentialGeneration: number;
};

/**
 * 台帳を引いた結果。**ストア障害と未登録を分ける**（#1237 の follow-up）。
 *
 * どちらも束縛は返さない（fail-closed）。分けるのは、PIN の認可で担当者に出す案内を
 * 変えるためだけ —— 障害時に「登録し直して」と案内すると、直らない作業をさせることになる。
 */
export type DeviceBindingLookup =
  | { kind: 'enrolled'; binding: ResolvedDeviceBinding }
  /** 台帳に無い・失効・id が空。 */
  | { kind: 'not_enrolled' }
  /** 台帳が読めなかった。登録の有無は**分からない**。 */
  | { kind: 'unavailable' };

/** 台帳を引き、登録済みかつ有効な端末なら束縛を返す。障害は `unavailable` として返す（throw しない）。 */
export async function lookupDeviceBinding(kioskId: string): Promise<DeviceBindingLookup> {
  const trimmed = kioskId.trim();
  if (!trimmed) return { kind: 'not_enrolled' };

  let device;
  try {
    device = await getTenantStore().devices.findDeviceById(asDeviceId(trimmed));
  } catch {
    return { kind: 'unavailable' };
  }
  if (!device || device.status !== 'active') return { kind: 'not_enrolled' };
  return {
    kind: 'enrolled',
    binding: {
      tenantId: asTenantId(String(device.tenantId)),
      siteId: asSiteId(String(device.siteId)),
      kioskId: trimmed,
      credentialGeneration: credentialGenerationOf(device),
    },
  };
}

/** 登録済みかつ有効な端末のみ束縛を返す。未登録・失効・ストア障害は null。 */
export async function resolveDeviceBinding(
  kioskId: string,
): Promise<ResolvedDeviceBinding | null> {
  const found = await lookupDeviceBinding(kioskId);
  return found.kind === 'enrolled' ? found.binding : null;
}

/**
 * 端末束縛から認可判定用の actor を組む。端末は `kiosk_device` 割り当て 1 件だけを持ち、
 * 管理系の権限は一切持たない（`resolveProductContext` が管理領域で弾く）。
 */
export function deviceActorFor(
  binding: Pick<ResolvedDeviceBinding, 'tenantId' | 'siteId' | 'kioskId'>,
): Actor {
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
