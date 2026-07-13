/**
 * kiosk 向け機能フラグの enforcement ゲート (#290 item4)。
 *
 * プラットフォームコンソール（#83 inc5a / #285）で無効化されたテナントの機能を、kiosk 設定
 * 配信 API（/api/kiosk/voice・motions・assets）で実際に止めるための解決ヘルパ。判定の純ロジックは
 * `@/domain/platform/feature-flags` の `isTenantFeatureEnabled`、本ファイルは I/O（ストア読取・
 * テナントスコープ解決）と fail-open 方針だけを担う。
 *
 * スコープ: kioskId（= Device.id）が渡された場合は Device レジストリ `findDeviceById` でその端末が
 * 属するテナントを解決し、**テナント別のフラグ**を適用する（resolveStayScope と同じ kiosk→tenant
 * 写像 #354 に基づく per-tenant enforcement、#290 残項目）。kioskId 未指定・未登録端末・空入力は
 * 既定テナント（default-scope）へフォールバックする（後方互換）。
 *
 * fail-open の根拠: kiosk は無人受付の主導線であり可用性優先（KioskFlow は各設定 API の失敗時に
 * 既定値で継続する設計）。フラグ既定値も「全機能有効」（DEFAULT_TENANT_FEATURE_FLAGS）なので、
 * レコード未作成・ストア障害時に有効側へ倒すのは既定挙動と整合する。ここで止まるのは
 * 「プラットフォーム管理者が明示的に無効化した」場合のみ（機能フラグは課金/契約に近い運用スイッチで、
 * セキュリティ境界ではない。セキュリティ制御は fail-closed の kiosk セッションゲート #239 が担う）。
 */
import { isTenantFeatureEnabled, type TenantFeatureFlagKey } from '@/domain/platform/feature-flags';
import { asDeviceId } from '@/domain/tenant/types';
import { defaultTenantIdFrom } from '@/lib/tenant/default-scope';
import { getTenantStore } from '@/lib/tenant/store';
import { getTenantFeatureFlagRecord } from './feature-flag-store';

/**
 * kioskId（= Device.id）からテナント ID を解決する。一致端末があればその端末のテナントを、
 * 無ければ既定テナントを返す。scope はサーバ権威（kioskId は kiosk セッション由来）でクライアント
 * 入力に依存しない。
 */
async function resolveKioskTenantId(kioskId?: string): Promise<string> {
  const trimmed = kioskId?.trim();
  if (trimmed) {
    const device = await getTenantStore().devices.findDeviceById(asDeviceId(trimmed));
    if (device) return String(device.tenantId);
  }
  return defaultTenantIdFrom();
}

/**
 * kiosk 機能フラグの実効値を返す。kioskId を渡すとその端末のテナントで、未指定なら既定テナントで
 * 解決する。端末解決・ストア障害いずれの失敗時も有効（fail-open）。
 */
export async function isKioskFeatureEnabled(
  key: TenantFeatureFlagKey,
  kioskId?: string,
): Promise<boolean> {
  try {
    const tenantId = await resolveKioskTenantId(kioskId);
    const record = await getTenantFeatureFlagRecord(tenantId);
    return isTenantFeatureEnabled(record, key);
  } catch {
    // fail-open: フラグ取得不能で受付端末を止めない（上記 docstring 参照）。
    return true;
  }
}
