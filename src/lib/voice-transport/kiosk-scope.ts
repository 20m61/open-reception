/**
 * kioskId から tenantId/siteId を解決する (issue #369)。
 *
 * `@/lib/platform/feature-flag-gate.ts` の `resolveKioskTenantId` と同じ kiosk→device
 * 写像（#354）を使うが、方針は異なる: 機能フラグは「セキュリティ境界ではない運用スイッチ」
 * であるため device store 障害時に fail-open で許可側へ倒してよいが、ここで解決する
 * tenantId/siteId は接続トークンへ刻む**セキュリティ境界の claims**そのものなので、
 * store 障害時は fail-open で誤ったスコープを黙って発行せず、呼び出し側（token API）が
 * 503 として扱えるよう例外を伝播する。
 *
 * 未登録 kioskId（dev seed 未投入・単一テナント運用）は障害ではなく想定内の状態なので、
 * 既定スコープへフォールバックする（`resolveDefaultScope` — 単一テナント運用の互換）。
 */
import { asDeviceId } from '@/domain/tenant/types';
import { resolveDefaultScope } from '@/lib/tenant/default-scope';
import { getTenantStore } from '@/lib/tenant/store';

export type KioskScope = { tenantId: string; siteId: string };

export async function resolveKioskScope(kioskId: string): Promise<KioskScope> {
  const trimmed = kioskId.trim();
  if (!trimmed) {
    const fallback = resolveDefaultScope();
    return { tenantId: String(fallback.tenantId), siteId: String(fallback.siteId) };
  }

  const device = await getTenantStore().devices.findDeviceById(asDeviceId(trimmed));
  if (device) {
    return { tenantId: String(device.tenantId), siteId: String(device.siteId) };
  }
  const fallback = resolveDefaultScope();
  return { tenantId: String(fallback.tenantId), siteId: String(fallback.siteId) };
}
