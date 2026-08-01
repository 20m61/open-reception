/**
 * 実効構成のセクションローダ (issue #419)。既存ストアを resolver の port に合わせる互換アダプタ。
 *
 * `docs/product-integration-plan.md` §4.1 の移行対象 API と 1:1 に対応する。ここが埋まっても
 * 個別 API は**残す**（rollback playbook の切り戻し先）。撤去は台帳 §9 B-03 の予告どおり別途行う。
 *
 * **グローバルストアの扱い（重要）**: branding / directory / voice / motions / assets の各ストアは
 * テナント次元を持たない（単一テナント運用の名残）。resolver 経由で任意テナントの構成を引けるように
 * なる分、素通しにすると「テナント A の管理者がテナント B の端末をプレビューしたら A の branding が
 * 出る」ような越境が起きる。そこで**既定テナント以外の要求では fail-closed で失敗**させる
 * （resolver が `section_unavailable` に写像する）。ストアをテナント対応にするのが本来の解で、
 * それまでは配らない側に倒す。
 */
import type {
  ConfigurationSectionLoaders,
  ConfigurationLoadInput,
} from '@/domain/product-context/resolver';
import type { ConfigurationSectionResult } from '@/domain/product-context/types';
import { TENANT_FEATURE_FLAG_KEYS } from '@/domain/platform/feature-flags';
import { getBrandingSettings } from '@/lib/branding/branding-store';
import { getKioskDirectory } from '@/lib/data-stores/directory-store';
import { getVoiceSettings } from '@/lib/voice/voice-store';
import { getKioskMotions } from '@/lib/motion/motion-store';
import { getKioskAssets } from '@/lib/assets/asset-store';
import { getLanguageSettings } from '@/lib/i18n/language-settings';
import { getKioskSignage } from '@/lib/signage/kiosk-signage';
import { resolveKioskStatusFor } from '@/lib/operating-policy/store';
import { getReceptionFlowService } from '@/lib/reception/flow-config/store';
import { isKioskFeatureEnabled } from '@/lib/platform/feature-flag-gate';
import { defaultTenantIdFrom } from '@/lib/tenant/default-scope';

/**
 * テナント次元を持たないストアを読む前のガード。既定テナント以外なら投げる
 * （呼び出し側 resolver が fail-closed で構成組み立てを中止する）。
 */
function assertGlobalStoreScope(input: ConfigurationLoadInput): void {
  const defaultTenantId = defaultTenantIdFrom();
  if (String(input.tenantId) !== defaultTenantId) {
    throw new Error(
      `configuration store is not tenant-scoped: refusing to serve tenant ${String(input.tenantId)}`,
    );
  }
}

const section = <T>(value: T, source: ConfigurationSectionResult['source']) => ({ value, source });

export function createSectionLoaders(now: () => Date = () => new Date()): ConfigurationSectionLoaders {
  return {
    async operatingPolicy(input) {
      const status = await resolveKioskStatusFor(
        String(input.tenantId),
        String(input.siteId),
        now().getTime(),
      );
      // 未設定は null（端末側 `operatingStateOf` が「判定不能」として通常受付に倒す既存契約）。
      return status ? section({ status }, 'site') : section({ status: null }, 'default');
    },

    async receptionFlow(input) {
      const flows = await getReceptionFlowService().listEnabledForKiosk(
        input.tenantId,
        input.siteId,
      );
      return section({ flows }, 'site');
    },

    async signage(input) {
      return section(await getKioskSignage(input.tenantId, input.siteId), 'site');
    },

    async directory(input) {
      assertGlobalStoreScope(input);
      return section(await getKioskDirectory(), 'tenant');
    },

    /**
     * **テナント対応済み** (#419 残増分)。`assertGlobalStoreScope` は外してある —
     * ストアがテナント別にキーを持つようになったので、既定以外のテナントへ配っても
     * 越境しない。残りのセクション（directory / voice / motions / assets）は
     * まだ単一テナントのストアなので guard を残す。
     */
    async branding(input) {
      return section(await getBrandingSettings(String(input.tenantId)), 'tenant');
    },

    /** テナント対応済み (#419 残増分)。guard は外してある。 */
    async voice(input) {
      const [settings, enabled] = await Promise.all([
        getVoiceSettings(String(input.tenantId)),
        isKioskFeatureEnabled('voiceSynthesis', input.kioskId),
      ]);
      // フラグ無効時も応答スキーマは保つ（既存 `/api/kiosk/voice` と同じ契約）。
      return section(enabled ? settings : { ...settings, ttsEnabled: false }, 'tenant');
    },

    /** テナント対応済み (#419 残増分)。guard は外してある。 */
    async motions(input) {
      if (!(await isKioskFeatureEnabled('avatarReception', input.kioskId))) {
        return section({ motions: {} }, 'default');
      }
      return section(await getKioskMotions(String(input.tenantId)), 'tenant');
    },

    /** テナント対応済み (#419 残増分)。guard は外してある。 */
    async avatar(input) {
      const [assets, enabled] = await Promise.all([
        getKioskAssets(String(input.tenantId)),
        isKioskFeatureEnabled('avatarReception', input.kioskId),
      ]);
      // アバター無効時は VRM / fallback 画像を落とす（背景はアバター機能ではないので維持）。
      return section(enabled ? assets : { backgroundUrl: assets.backgroundUrl }, 'tenant');
    },

    /** テナント対応済み (#419 残増分)。guard は外してある。 */
    async languages(input) {
      return section(await getLanguageSettings(String(input.tenantId)), 'tenant');
    },

    async featureFlags(input) {
      const entries = await Promise.all(
        TENANT_FEATURE_FLAG_KEYS.map(
          async (key) => [key, await isKioskFeatureEnabled(key, input.kioskId)] as const,
        ),
      );
      return section(Object.fromEntries(entries), 'tenant');
    },

    async integrations() {
      // 連携設定は秘匿値と表裏（#405）。端末構成には載せない。presence が要る画面は
      // developer 専用 API を使う。ここで空を返すことを契約として固定する。
      return section({}, 'default');
    },
  };
}
