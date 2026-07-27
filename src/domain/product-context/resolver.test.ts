import { describe, expect, it } from 'vitest';
import {
  countFallbackSections,
  createEffectiveKioskConfigurationResolver,
  type ConfigurationSectionLoaders,
  type ExperienceVersionLookup,
} from './resolver';
import { CONFIGURATION_SECTIONS, type ProductContext } from './types';
import { asSiteId, asTenantId } from '@/domain/tenant/types';

const PUBLISHED = { id: 'ver-1', status: 'published', revision: 3 } as const;

function versionLookup(
  resolved: { id: string; status: 'draft' | 'published'; revision: number } | null,
): ExperienceVersionLookup {
  return { resolve: async () => resolved };
}

/** 全セクションを既定値で埋めるローダ集合。上書きしたいセクションだけ差し替える。 */
function loaders(
  over: Partial<ConfigurationSectionLoaders> = {},
): ConfigurationSectionLoaders {
  const base = {} as ConfigurationSectionLoaders;
  for (const section of CONFIGURATION_SECTIONS) {
    base[section] = async () => ({ value: { section }, source: 'default' as const });
  }
  return { ...base, ...over };
}

const RUNTIME_CONTEXT: ProductContext = {
  actorId: 'kiosk-1',
  role: 'kiosk_device',
  area: 'kiosk-runtime',
  tenantId: asTenantId('tenant-a'),
  siteId: asSiteId('site-1'),
  kioskId: 'kiosk-1',
};

const PREVIEW_CONTEXT: ProductContext = {
  actorId: 'admin-1',
  role: 'tenant_admin',
  area: 'kiosk-preview',
  tenantId: asTenantId('tenant-a'),
  siteId: asSiteId('site-1'),
  kioskId: 'kiosk-1',
};

const CLOCK = () => new Date('2026-07-27T10:00:00.000Z');

describe('createEffectiveKioskConfigurationResolver', () => {
  it('全セクションを 1 つの構成へ束ね、由来・指紋・生成時刻を返す', async () => {
    const resolver = createEffectiveKioskConfigurationResolver({
      versions: versionLookup(PUBLISHED),
      loaders: loaders({
        branding: async () => ({ value: { accentColor: '#123456' }, source: 'tenant' }),
        signage: async () => ({ value: { enabled: false, items: [] }, source: 'site' }),
      }),
      now: CLOCK,
    });

    const result = await resolver.resolve(RUNTIME_CONTEXT, { kind: 'published' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const config = result.value;
    expect(config.context).toEqual({
      tenantId: asTenantId('tenant-a'),
      siteId: asSiteId('site-1'),
      kioskId: 'kiosk-1',
    });
    expect(config.version).toMatchObject({ id: 'ver-1', status: 'published', revision: 3 });
    expect(config.branding).toEqual({ accentColor: '#123456' });
    expect(config.provenance.branding).toBe('tenant');
    expect(config.provenance.signage).toBe('site');
    expect(config.provenance.voice).toBe('default');
    expect(Object.keys(config.provenance).sort()).toEqual([...CONFIGURATION_SECTIONS].sort());
    expect(config.configHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(config.generatedAt).toBe('2026-07-27T10:00:00.000Z');
  });

  it('同一 version・同一端末なら、プレビューと本番実行で configHash が一致する', async () => {
    const deps = {
      versions: versionLookup(PUBLISHED),
      loaders: loaders({
        branding: async () => ({ value: { accentColor: '#123456' }, source: 'tenant' as const }),
      }),
      now: CLOCK,
    };
    const resolver = createEffectiveKioskConfigurationResolver(deps);

    const runtime = await resolver.resolve(RUNTIME_CONTEXT, { kind: 'published' });
    const preview = await resolver.resolve(PREVIEW_CONTEXT, { kind: 'published' });

    expect(runtime.ok && preview.ok).toBe(true);
    if (!runtime.ok || !preview.ok) return;
    expect(preview.value.configHash).toBe(runtime.value.configHash);
  });

  it('端末実行では draft 版を解決しない（pinned で draft を指しても拒否する）', async () => {
    const resolver = createEffectiveKioskConfigurationResolver({
      versions: versionLookup({ id: 'ver-draft', status: 'draft', revision: 9 }),
      loaders: loaders(),
      now: CLOCK,
    });

    const result = await resolver.resolve(RUNTIME_CONTEXT, {
      kind: 'pinned',
      experienceVersionId: 'ver-draft',
    });

    expect(result).toEqual({ ok: false, error: { reason: 'draft_not_allowed' } });
  });

  it('プレビューでは draft 版を解決できる', async () => {
    const resolver = createEffectiveKioskConfigurationResolver({
      versions: versionLookup({ id: 'ver-draft', status: 'draft', revision: 9 }),
      loaders: loaders(),
      now: CLOCK,
    });

    const result = await resolver.resolve(PREVIEW_CONTEXT, { kind: 'draft' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version.status).toBe('draft');
  });

  it('版が見つからなければ version_not_found', async () => {
    const resolver = createEffectiveKioskConfigurationResolver({
      versions: versionLookup(null),
      loaders: loaders(),
      now: CLOCK,
    });

    const result = await resolver.resolve(RUNTIME_CONTEXT, { kind: 'published' });

    expect(result).toEqual({ ok: false, error: { reason: 'version_not_found' } });
  });

  it('コンテキストに tenant/site/kiosk が揃っていなければ解決しない', async () => {
    const resolver = createEffectiveKioskConfigurationResolver({
      versions: versionLookup(PUBLISHED),
      loaders: loaders(),
      now: CLOCK,
    });

    const result = await resolver.resolve(
      { ...PREVIEW_CONTEXT, kioskId: undefined },
      { kind: 'published' },
    );

    expect(result).toEqual({ ok: false, error: { reason: 'context_incomplete' } });
  });

  it('セクションのローダが失敗したら部分構成を返さず section_unavailable にする', async () => {
    const resolver = createEffectiveKioskConfigurationResolver({
      versions: versionLookup(PUBLISHED),
      loaders: loaders({
        directory: async () => {
          throw new Error('store unavailable');
        },
      }),
      now: CLOCK,
    });

    const result = await resolver.resolve(RUNTIME_CONTEXT, { kind: 'published' });

    expect(result).toEqual({
      ok: false,
      error: { reason: 'section_unavailable', section: 'directory' },
    });
  });

  it('秘匿情報を返すローダがあれば構成を組み立てず fail-closed で拒否する', async () => {
    const resolver = createEffectiveKioskConfigurationResolver({
      versions: versionLookup(PUBLISHED),
      loaders: loaders({
        integrations: async () => ({
          value: { vonage: { applicationId: 'app-1', privateKey: 'TEST-not-a-real-key' } },
          source: 'tenant',
        }),
      }),
      now: CLOCK,
    });

    const result = await resolver.resolve(RUNTIME_CONTEXT, { kind: 'published' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ reason: 'forbidden_value', section: 'integrations' });
  });

  it('countFallbackSections が既定値へ落ちたセクション数を数える（fallback 観測）', async () => {
    const resolver = createEffectiveKioskConfigurationResolver({
      versions: versionLookup(PUBLISHED),
      loaders: loaders({
        branding: async () => ({ value: {}, source: 'tenant' }),
        voice: async () => ({ value: {}, source: 'kiosk' }),
      }),
      now: CLOCK,
    });

    const result = await resolver.resolve(RUNTIME_CONTEXT, { kind: 'published' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(countFallbackSections(result.value)).toBe(CONFIGURATION_SECTIONS.length - 2);
  });

  it('ローダには解決済みスコープと版だけを渡す（クライアント値を素通ししない）', async () => {
    const seen: unknown[] = [];
    const resolver = createEffectiveKioskConfigurationResolver({
      versions: versionLookup(PUBLISHED),
      loaders: loaders({
        branding: async (input) => {
          seen.push(input);
          return { value: {}, source: 'tenant' };
        },
      }),
      now: CLOCK,
    });

    await resolver.resolve(RUNTIME_CONTEXT, { kind: 'published' });

    expect(seen).toEqual([
      {
        tenantId: asTenantId('tenant-a'),
        siteId: asSiteId('site-1'),
        kioskId: 'kiosk-1',
        version: PUBLISHED,
      },
    ]);
  });
});
