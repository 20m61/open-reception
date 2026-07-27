/**
 * 受付体験バージョンのストア組み立て (issue #420 increment 2)。
 *
 * route から使う `ExperienceVersionService` を 1 つ生成して共有する
 * （`src/lib/reception/flow-config/store.ts` と同方針）。
 *
 * スナップショット取得は **live なセクションローダを直接叩く**（resolver を通さない）。
 * resolver は「版 → 構成」を組み立てる責務で、ここが欲しいのは逆向きの「現ストア → 版の中身」
 * だからである。取得に失敗したセクションが 1 つでもあれば例外を投げ、サービス側が
 * `snapshot_failed` として下書き作成を中止する（中身の欠けた版を積まない）。
 */
import { computeSectionsHash } from '@/domain/product-context/config-hash';
import { CONFIGURATION_SECTIONS } from '@/domain/product-context/types';
import type { ExperienceConfigurationSnapshot } from '@/domain/experience-version/types';
import type { SiteId, TenantId } from '@/domain/tenant/types';
import { createSectionLoaders } from '@/lib/product-context/section-loaders';
import { getTenantStore } from '@/lib/tenant/store';
import { DataBackedExperienceRepository } from './repository';
import { ExperienceVersionService } from './service';

/** 現在の設定ストアから構成スナップショットを取る。 */
export async function captureCurrentSnapshot(input: {
  tenantId: TenantId;
  siteId: SiteId;
  kioskId: string;
}): Promise<ExperienceConfigurationSnapshot> {
  const loaders = createSectionLoaders();
  const loadInput = {
    ...input,
    // ローダは版を参照しない（版に依存する値はまだ無い）。取得用の擬似版を渡す。
    version: { id: 'capture', status: 'draft' as const, revision: 0 },
  };

  const sections: Record<string, unknown> = {};
  const provenance: Record<string, string> = {};
  for (const name of CONFIGURATION_SECTIONS) {
    // 逐次実行。失敗したセクション名をそのまま例外に載せたいので Promise.all にしない。
    const result = await loaders[name](loadInput);
    sections[name] = result.value;
    provenance[name] = result.source;
  }

  return { sections, provenance, configHash: computeSectionsHash(sections) };
}

/**
 * 下書き保存時に構成を解決するための代表端末を拠点から選ぶ。
 *
 * 現時点で端末ごとに値が変わるセクションは無いため、拠点の有効な端末 1 台で足りる
 * （`./service.ts` の粒度メモ参照）。**暫定 ID をハードコードしない**ためにここで解決する
 * （`docs/product-integration-plan.md` §6）。端末が 1 台も無ければ null。
 */
export async function resolveRepresentativeKioskId(
  tenantId: TenantId,
  siteId: SiteId,
): Promise<string | null> {
  const devices = await getTenantStore().devices.listDevices(tenantId, siteId);
  const active = devices
    .filter((d) => d.status === 'active')
    .map((d) => String(d.id))
    .sort();
  return active[0] ?? null;
}

let service: ExperienceVersionService | undefined;

export function getExperienceVersionService(): ExperienceVersionService {
  service ??= new ExperienceVersionService(new DataBackedExperienceRepository(), {
    captureSnapshot: captureCurrentSnapshot,
  });
  return service;
}

/** テスト用: サービスを作り直す。 */
export function __resetExperienceVersionService(): void {
  service = undefined;
}
