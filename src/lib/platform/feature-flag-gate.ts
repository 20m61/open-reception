/**
 * kiosk 向け機能フラグの enforcement ゲート (#290 item4)。
 *
 * プラットフォームコンソール（#83 inc5a / #285）で無効化されたテナントの機能を、kiosk 設定
 * 配信 API（/api/kiosk/voice・motions・assets）で実際に止めるための解決ヘルパ。判定の純ロジックは
 * `@/domain/platform/feature-flags` の `isTenantFeatureEnabled`、本ファイルは I/O（ストア読取・
 * テナントスコープ解決）と fail-open 方針だけを担う。
 *
 * スコープ: kiosk エンドポイントはまだ端末→テナントの実解決を持たない（kiosk-store は flat、
 * `resolveDefaultScope` の docstring 参照）ため、**既定テナント（default-scope）のフラグ**を
 * 適用する。kiosk→tenant 写像に基づくテナント別 enforcement は後続増分（#290 残項目）。
 *
 * fail-open の根拠: kiosk は無人受付の主導線であり可用性優先（KioskFlow は各設定 API の失敗時に
 * 既定値で継続する設計）。フラグ既定値も「全機能有効」（DEFAULT_TENANT_FEATURE_FLAGS）なので、
 * レコード未作成・ストア障害時に有効側へ倒すのは既定挙動と整合する。ここで止まるのは
 * 「プラットフォーム管理者が明示的に無効化した」場合のみ（機能フラグは課金/契約に近い運用スイッチで、
 * セキュリティ境界ではない。セキュリティ制御は fail-closed の kiosk セッションゲート #239 が担う）。
 */
import { isTenantFeatureEnabled, type TenantFeatureFlagKey } from '@/domain/platform/feature-flags';
import { defaultTenantIdFrom } from '@/lib/tenant/default-scope';
import { getTenantFeatureFlagRecord } from './feature-flag-store';

/** 既定テナントスコープで機能フラグの実効値を返す。ストア障害時は有効（fail-open）。 */
export async function isKioskFeatureEnabled(key: TenantFeatureFlagKey): Promise<boolean> {
  try {
    const record = await getTenantFeatureFlagRecord(defaultTenantIdFrom());
    return isTenantFeatureEnabled(record, key);
  } catch {
    // fail-open: フラグ取得不能で受付端末を止めない（上記 docstring 参照）。
    return true;
  }
}
