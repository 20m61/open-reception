/**
 * 実効構成のセクションローダのテスト (#419)。
 *
 * 要点は 2 つ:
 *   1. テナント次元を持つストア（signage / flow / operating policy）には解決済みスコープを渡す。
 *   2. **テナント次元を持たないグローバルストア**（branding / directory / voice / motions / assets）は、
 *      既定テナント以外の要求に対して fail-closed で失敗させる（他テナントへ配らない）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getBrandingSettings = vi.fn();
const getKioskDirectory = vi.fn();
const getVoiceSettings = vi.fn();
const getKioskMotions = vi.fn();
const getKioskAssets = vi.fn();
const getLanguageSettings = vi.fn();
const getKioskSignage = vi.fn();
const resolveKioskStatusFor = vi.fn();
const listEnabledForKiosk = vi.fn();
const isKioskFeatureEnabled = vi.fn();

/**
 * **モックもテナント引数を受ける** (#419 残増分)。
 *
 * 引数を無視するモックのままだと、loader が `tenantId` を渡し忘れても検査が緑になる
 * （＝越境の退行を捕まえられない）。実ストアと同じく「テナントごとに別の値」を返させる。
 */
vi.mock('@/lib/branding/branding-store', () => ({
  getBrandingSettings: (tenantId: string) => getBrandingSettings(tenantId),
}));
vi.mock('@/lib/data-stores/directory-store', () => ({
  getKioskDirectory: () => getKioskDirectory(),
}));
vi.mock('@/lib/voice/voice-store', () => ({ getVoiceSettings: () => getVoiceSettings() }));
vi.mock('@/lib/motion/motion-store', () => ({ getKioskMotions: () => getKioskMotions() }));
vi.mock('@/lib/assets/asset-store', () => ({ getKioskAssets: () => getKioskAssets() }));
vi.mock('@/lib/i18n/language-settings', () => ({
  getLanguageSettings: () => getLanguageSettings(),
}));
vi.mock('@/lib/signage/kiosk-signage', () => ({
  getKioskSignage: (...a: unknown[]) => getKioskSignage(...a),
}));
vi.mock('@/lib/operating-policy/store', () => ({
  resolveKioskStatusFor: (...a: unknown[]) => resolveKioskStatusFor(...a),
}));
vi.mock('@/lib/reception/flow-config/store', () => ({
  getReceptionFlowService: () => ({
    listEnabledForKiosk: (...a: unknown[]) => listEnabledForKiosk(...a),
  }),
}));
vi.mock('@/lib/platform/feature-flag-gate', () => ({
  isKioskFeatureEnabled: (...a: unknown[]) => isKioskFeatureEnabled(...a),
}));

import { createSectionLoaders } from './section-loaders';
import { asSiteId, asTenantId } from '@/domain/tenant/types';
import { DEFAULT_TENANT_ID } from '@/lib/tenant/default-scope';

const VERSION = { id: 'current', status: 'published' as const, revision: 1 };

function loadInput(tenantId = DEFAULT_TENANT_ID) {
  return {
    tenantId: asTenantId(tenantId),
    siteId: asSiteId('site-1'),
    kioskId: 'kiosk-1',
    version: VERSION,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // 既定テナントだけ値を持ち、他テナントは未設定（＝実ストアのテナント別キーと同じ形）。
  getBrandingSettings.mockImplementation(async (tenantId: string) =>
    tenantId === DEFAULT_TENANT_ID ? { companyName: 'AVITA', accentColor: '#123456' } : {},
  );
  getKioskDirectory.mockResolvedValue({ departments: [], staff: [] });
  getVoiceSettings.mockResolvedValue({ ttsEnabled: true, rate: 1 });
  getKioskMotions.mockResolvedValue({ motions: { idle: '/idle.vrma' } });
  getKioskAssets.mockResolvedValue({ backgroundUrl: '/bg.png', vrmUrl: '/a.vrm' });
  getLanguageSettings.mockResolvedValue({ defaultLanguage: 'ja', enabled: ['ja', 'en'] });
  getKioskSignage.mockResolvedValue({ enabled: true, items: [] });
  resolveKioskStatusFor.mockResolvedValue({ state: 'open' });
  listEnabledForKiosk.mockResolvedValue([{ id: 'flow-1' }]);
  isKioskFeatureEnabled.mockResolvedValue(true);
});

describe('createSectionLoaders / テナント次元を持つストア', () => {
  it('signage には解決済みの tenant/site を渡す', async () => {
    const loaders = createSectionLoaders();

    const result = await loaders.signage(loadInput());

    expect(getKioskSignage).toHaveBeenCalledWith(asTenantId(DEFAULT_TENANT_ID), asSiteId('site-1'));
    expect(result).toEqual({ value: { enabled: true, items: [] }, source: 'site' });
  });

  it('receptionFlow には解決済みの tenant/site を渡す', async () => {
    const loaders = createSectionLoaders();

    const result = await loaders.receptionFlow(loadInput());

    expect(listEnabledForKiosk).toHaveBeenCalledWith(
      asTenantId(DEFAULT_TENANT_ID),
      asSiteId('site-1'),
    );
    expect(result).toEqual({ value: { flows: [{ id: 'flow-1' }] }, source: 'site' });
  });

  it('operatingPolicy は tenant/site で判定する（既定スコープへ落とさない）', async () => {
    const loaders = createSectionLoaders();

    const result = await loaders.operatingPolicy(loadInput());

    expect(resolveKioskStatusFor).toHaveBeenCalledWith(
      DEFAULT_TENANT_ID,
      'site-1',
      expect.any(Number),
    );
    expect(result).toEqual({ value: { status: { state: 'open' } }, source: 'site' });
  });

  it('営業ポリシー未設定は null を由来 default で返す（fail-open は呼び出し側の既存挙動に委ねる）', async () => {
    resolveKioskStatusFor.mockResolvedValue(undefined);
    const loaders = createSectionLoaders();

    await expect(loaders.operatingPolicy(loadInput())).resolves.toEqual({
      value: { status: null },
      source: 'default',
    });
  });
});

describe('createSectionLoaders / グローバルストアの越境防止', () => {
  /**
   * **まだテナント次元を持たないストア。** branding は #419 残増分でテナント対応したので
   * ここから外してある（下の別 describe で「テナント別に引ける」ことを固定する）。
   * 残りを対応させたら 1 つずつここから外す — **空になったら guard 自体を撤去する**。
   */
  const globalSections = ['directory', 'voice', 'motions', 'avatar'] as const;

  it('既定テナントの要求では従来どおり値を返す', async () => {
    const loaders = createSectionLoaders();

    await expect(loaders.branding(loadInput())).resolves.toEqual({
      value: { companyName: 'AVITA', accentColor: '#123456' },
      source: 'tenant',
    });
  });

  it.each(globalSections)('別テナントの要求では %s を fail-closed で失敗させる', async (section) => {
    const loaders = createSectionLoaders();

    await expect(loaders[section](loadInput('tenant-other'))).rejects.toThrow(
      /not tenant-scoped/,
    );
  });

  /**
   * **fail-closed を外した代わりに、越境しないことを直接固定する** (#419 残増分)。
   *
   * guard を消すだけだと「別テナントへ既定テナントの値を配る」退行に気づけない。
   * ストアがテナント別キーを持つようになったことを、loader の側からも確認する。
   */
  it('branding は別テナントでも失敗せず、そのテナントの値を返す', async () => {
    const loaders = createSectionLoaders();

    await expect(loaders.branding(loadInput('tenant-other'))).resolves.toMatchObject({
      source: 'tenant',
    });
  });

  it('branding は別テナントへ既定テナントの値を配らない', async () => {
    const loaders = createSectionLoaders();

    const other = await loaders.branding(loadInput('tenant-other'));
    // 既定テナントは mock で `AVITA` を返す。それが別テナントに出たら越境。
    expect(other.value).not.toMatchObject({ companyName: 'AVITA' });
  });

  it('越境要求ではグローバルストアを読みにいかない', async () => {
    const loaders = createSectionLoaders();

    await expect(loaders.directory(loadInput('tenant-other'))).rejects.toThrow();
    expect(getKioskDirectory).not.toHaveBeenCalled();
  });
});

describe('createSectionLoaders / 機能フラグの適用', () => {
  it('avatarReception が無効なら motions は空・avatar はアバター URL を落とす', async () => {
    isKioskFeatureEnabled.mockImplementation(async (flag: string) => flag !== 'avatarReception');
    const loaders = createSectionLoaders();

    await expect(loaders.motions(loadInput())).resolves.toEqual({
      value: { motions: {} },
      source: 'default',
    });
    await expect(loaders.avatar(loadInput())).resolves.toEqual({
      value: { backgroundUrl: '/bg.png' },
      source: 'tenant',
    });
  });

  it('voiceSynthesis が無効なら ttsEnabled を false に強制する（スキーマは保つ）', async () => {
    isKioskFeatureEnabled.mockImplementation(async (flag: string) => flag !== 'voiceSynthesis');
    const loaders = createSectionLoaders();

    await expect(loaders.voice(loadInput())).resolves.toEqual({
      value: { ttsEnabled: false, rate: 1 },
      source: 'tenant',
    });
  });

  it('featureFlags セクションは端末のテナントで解決した実効値を返す', async () => {
    isKioskFeatureEnabled.mockImplementation(async (flag: string) => flag === 'voiceSynthesis');
    const loaders = createSectionLoaders();

    await expect(loaders.featureFlags(loadInput())).resolves.toEqual({
      value: { voiceSynthesis: true, avatarReception: false },
      source: 'tenant',
    });
  });
});

describe('createSectionLoaders / integrations', () => {
  it('秘匿設定を配らないため常に空を返す（presence は developer 専用 API の担当）', async () => {
    const loaders = createSectionLoaders();

    await expect(loaders.integrations(loadInput())).resolves.toEqual({
      value: {},
      source: 'default',
    });
  });
});
