/**
 * `EffectiveKioskConfigurationResolver` の契約と純粋な組み立て (issue #419)。
 *
 * 「プレビューと本番キオスクで同じ resolver を利用する」ための境界。ストア接続・HTTP・
 * 個別設定 API の互換アダプタは**この module には入れない**（後続 increment）。ここが持つのは:
 *   - セクションローダの port（tenant/site/kiosk/version スコープだけを受け取る）
 *   - 受付体験バージョンの解決 port
 *   - 由来（provenance）付きの組み立て・指紋計算・ペイロード契約の強制
 *
 * 失敗は fail-closed。部分的な構成を返すと「設定したはずの値が効いていない端末」が生まれ、
 * 原因が構成なのか配線なのか切り分けられなくなるため、1 セクションでも欠けたら拒否して
 * 呼び出し側の互換経路（既存の個別 API・rollback playbook）へ倒す。
 *
 * **呼び出し側の義務（純関数では担保できない）**:
 *   1. `context` は必ず `resolveProductContext` の戻り値を渡す（query の値を組み立てて渡さない）。
 *   2. `kioskId` が `tenantId`/`siteId` 配下の端末であることの実在検証は I/O を伴うため、
 *      `ExperienceVersionLookup` 実装または route 側で行う（`kiosk-preview` で他テナントの端末 ID を
 *      指定されても、版が見つからず `version_not_found` になる実装にすること）。
 *   3. セクションローダは受け取った tenant/site/kiosk で必ず絞り込む。グローバルストアをそのまま
 *      返す現行実装（`/api/kiosk/branding` 等）を素通しでローダにしない。
 */
import type { SiteId, TenantId } from '@/domain/tenant/types';
import { computeConfigHash } from './config-hash';
import { findForbiddenConfigurationValues, type ForbiddenValueKind } from './payload-contract';
import {
  CONFIGURATION_SECTIONS,
  type ConfigurationSectionName,
  type ConfigurationSectionResult,
  type ConfigurationSource,
  type ConfigurationVersionSelector,
  type EffectiveKioskConfiguration,
  type ExperienceVersionRef,
  type ProductContext,
} from './types';

/** ローダに渡す解決済みスコープ。クライアント由来の値は含めない。 */
export type ConfigurationLoadInput = {
  tenantId: TenantId;
  siteId: SiteId;
  kioskId: string;
  version: ExperienceVersionRef;
};

export type ConfigurationSectionLoader<T = unknown> = (
  input: ConfigurationLoadInput,
) => Promise<ConfigurationSectionResult<T>> | ConfigurationSectionResult<T>;

export type ConfigurationSectionLoaders = Record<
  ConfigurationSectionName,
  ConfigurationSectionLoader
>;

/** 受付体験バージョンの解決 port（#420 の lifecycle 実装が満たす）。 */
export type ExperienceVersionLookup = {
  resolve(input: {
    tenantId: TenantId;
    siteId: SiteId;
    kioskId: string;
    selector: ConfigurationVersionSelector;
  }): Promise<ExperienceVersionRef | null> | ExperienceVersionRef | null;
};

export type EffectiveConfigurationFailure =
  | { reason: 'context_incomplete' }
  | { reason: 'version_not_found' }
  | { reason: 'draft_not_allowed' }
  | { reason: 'section_unavailable'; section: ConfigurationSectionName }
  | {
      reason: 'forbidden_value';
      section: ConfigurationSectionName;
      path: string;
      kind: ForbiddenValueKind;
    };

export type EffectiveConfigurationResult =
  | { ok: true; value: EffectiveKioskConfiguration }
  | { ok: false; error: EffectiveConfigurationFailure };

export type EffectiveKioskConfigurationResolver = {
  resolve(
    context: ProductContext,
    selector: ConfigurationVersionSelector,
  ): Promise<EffectiveConfigurationResult>;
};

export type ResolverDeps = {
  versions: ExperienceVersionLookup;
  loaders: ConfigurationSectionLoaders;
  /** 生成時刻の注入（テスト決定化）。既定は実時刻。 */
  now?: () => Date;
};

export function createEffectiveKioskConfigurationResolver(
  deps: ResolverDeps,
): EffectiveKioskConfigurationResolver {
  const now = deps.now ?? (() => new Date());

  return {
    async resolve(context, selector) {
      const { tenantId, siteId, kioskId } = context;
      if (!tenantId || !siteId || !kioskId) {
        return { ok: false, error: { reason: 'context_incomplete' } };
      }

      const version = await deps.versions.resolve({ tenantId, siteId, kioskId, selector });
      if (!version) return { ok: false, error: { reason: 'version_not_found' } };
      // 端末には published のみ。selector が pinned でも、指した版が draft なら配信しない。
      if (context.area === 'kiosk-runtime' && version.status === 'draft') {
        return { ok: false, error: { reason: 'draft_not_allowed' } };
      }

      const loadInput: ConfigurationLoadInput = { tenantId, siteId, kioskId, version };
      const loaded = await Promise.all(
        CONFIGURATION_SECTIONS.map(async (section) => {
          try {
            return { section, result: await deps.loaders[section](loadInput) };
          } catch {
            // 失敗理由（例外の中身）は呼び出し側でログする。ここでは構成へ混ぜない。
            return { section, result: null };
          }
        }),
      );

      const sections: Partial<Record<ConfigurationSectionName, unknown>> = {};
      const provenance = {} as Record<ConfigurationSectionName, ConfigurationSource>;
      for (const { section, result } of loaded) {
        if (result === null) {
          return { ok: false, error: { reason: 'section_unavailable', section } };
        }
        const violation = findForbiddenConfigurationValues(result.value, section)[0];
        if (violation) {
          return {
            ok: false,
            error: {
              reason: 'forbidden_value',
              section,
              path: violation.path,
              kind: violation.kind,
            },
          };
        }
        sections[section] = result.value;
        provenance[section] = result.source;
      }

      const config = {
        context: { tenantId, siteId, kioskId },
        version,
        ...(sections as Record<ConfigurationSectionName, unknown>),
        provenance,
        configHash: computeConfigHash({
          context: { tenantId, siteId, kioskId },
          version,
          sections,
        }),
        generatedAt: now().toISOString(),
      } as EffectiveKioskConfiguration;

      return { ok: true, value: config };
    },
  };
}

/**
 * 既定値へ落ちたセクション数（#419 観測項目の config source/fallback counts）。
 * 恒常的に増えていれば「管理画面で設定したのに端末へ届いていない」配線欠落の兆候。
 */
export function countFallbackSections(config: EffectiveKioskConfiguration): number {
  return Object.values(config.provenance).filter((source) => source === 'default').length;
}
