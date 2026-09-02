/**
 * 「どの版を、どこから読んで配るか」の決定 (issue #419 × #420 increment 2)。
 *
 * #419 の resolver は「セクションローダ + 版」を受け取って構成を組み立てるところまでを担う。
 * その**入力を決める**のがここ:
 *
 *   - 公開版が在り、スナップショットを持つ → **スナップショットから配る**（可変ストアを読まない）。
 *     これが「管理画面の保存が端末へ即時反映されない」を成立させている実体。
 *   - 下書きを指定 → 下書きのスナップショットから配る（公開したら何が出るかを正確に見せる）。
 *   - 版がまだ無い（体験未作成・移行前） → **live なストアから配る**（従来どおりの挙動）。
 *     版管理を導入していない拠点を壊さないための互換経路。
 *
 * `version-lookup.ts`（第 18 wave の暫定実装）はこの module に置き換わった。
 */
import { draftVersion, publishedVersion } from '@/domain/experience-version/lifecycle';
import type {
  ExperienceConfigurationSnapshot,
  ReceptionExperienceVersion,
} from '@/domain/experience-version/types';
import type { ConfigurationSectionLoaders } from '@/domain/product-context/resolver';
import {
  CONFIGURATION_SECTIONS,
  type ConfigurationSectionName,
  type ConfigurationSource,
  type ConfigurationVersionSelector,
  type ExperienceVersionRef,
} from '@/domain/product-context/types';
import type { SiteId, TenantId } from '@/domain/tenant/types';
import { getExperienceVersionService } from '@/lib/experience-version/store';
import { createSectionLoaders } from './section-loaders';

/** 版がまだ無い拠点で使う擬似版（live ストア配信）。 */
export const LIVE_VERSION_ID = 'live';

const LIVE_VERSION: ExperienceVersionRef = {
  id: LIVE_VERSION_ID,
  status: 'published',
  revision: 0,
};

export type ConfigurationPlan = {
  version: ExperienceVersionRef;
  loaders: ConfigurationSectionLoaders;
  /** スナップショット配信か live ストア配信か（観測・デバッグ用）。 */
  origin: 'snapshot' | 'live';
};

function isConfigurationSource(value: unknown): value is ConfigurationSource {
  return (
    value === 'version' ||
    value === 'kiosk' ||
    value === 'site' ||
    value === 'tenant' ||
    value === 'default'
  );
}

/**
 * スナップショットの中身をそのまま返すローダ集合。
 * スナップショット取得後に増えたセクションは空 + `default` で返す（欠落で全体を落とさない。
 * 取得時の検証が warning で報告している）。
 */
export function createSnapshotLoaders(
  snapshot: ExperienceConfigurationSnapshot,
): ConfigurationSectionLoaders {
  const loaders = {} as ConfigurationSectionLoaders;
  for (const name of CONFIGURATION_SECTIONS) {
    loaders[name] = () => {
      if (!(name in snapshot.sections)) return { value: {}, source: 'default' as const };
      const source = snapshot.provenance?.[name];
      return {
        value: snapshot.sections[name],
        source: isConfigurationSource(source) ? source : 'version',
      };
    };
  }
  return loaders;
}

function refOf(
  experienceId: string,
  version: ReceptionExperienceVersion,
): ExperienceVersionRef {
  return {
    id: `${experienceId}#${version.revision}`,
    status: version.status === 'draft' ? 'draft' : 'published',
    revision: version.revision,
    publishedAt: version.publishedAt,
    // 端末が heartbeat で報告する値（内容の指紋）。スナップショット未設定の旧版は無し。
    contentHash: version.snapshot?.configHash,
  };
}

/**
 * 配信計画を決める。該当する版が無ければ null（呼び出し側は 404）。
 * ただし**版管理をまだ使っていない拠点**では live 配信の計画を返す（published 指定時のみ）。
 */
export async function resolveConfigurationPlan(input: {
  tenantId: TenantId;
  siteId: SiteId;
  selector: ConfigurationVersionSelector;
}): Promise<ConfigurationPlan | null> {
  const experience = await getExperienceVersionService().getBySite(input.tenantId, input.siteId);

  if (!experience) {
    // 版管理未導入の拠点。draft は存在しないので解決しない。
    return input.selector.kind === 'draft'
      ? null
      : { version: LIVE_VERSION, loaders: createSectionLoaders(), origin: 'live' };
  }

  const selector = input.selector;
  let target;
  if (selector.kind === 'draft') {
    target = draftVersion(experience);
  } else if (selector.kind === 'pinned') {
    target = experience.versions.find(
      (v) => `${experience.id}#${v.revision}` === selector.experienceVersionId,
    );
  } else {
    target = publishedVersion(experience);
  }

  if (!target) {
    // published が無い（下書きのみ）状態では live へ倒さない。公開していない構成を
    // 「公開版」として配ってしまうため。
    return null;
  }

  const version = refOf(experience.id, target);
  return target.snapshot
    ? { version, loaders: createSnapshotLoaders(target.snapshot), origin: 'snapshot' }
    : { version, loaders: createSectionLoaders(), origin: 'live' };
}

/** `ConfigurationSectionName` の網羅を型で固定するための再輸出（テスト用）。 */
export type { ConfigurationSectionName };
