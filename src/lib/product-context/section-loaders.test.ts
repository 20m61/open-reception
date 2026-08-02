/**
 * 実効構成のセクションローダのテスト (#419)。
 *
 * 要点は 2 つ:
 *   1. テナント次元を持つストア（signage / flow / operating policy）には解決済みスコープを渡す。
 *   2. **全ストアがテナント対応済み**（#419 残増分）。かつて fail-closed で落としていた
 *      branding / directory / voice / motions / avatar / languages は、別テナントでも失敗せず、
 *      かつ**そのテナントのキーで読む**ことを引数で固定する（渡し忘れると越境する）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getBrandingSettings = vi.fn();
const getVisitorDirectory = vi.fn();
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
vi.mock('@/lib/organization/organization-service', () => ({
  getVisitorDirectory: (scope: unknown) => getVisitorDirectory(scope),
  // モジュール全体を差し替えるので、同モジュールの他 export も置いておく。落とすと
  // 将来 section-loaders がそちらを触った瞬間に `undefined is not a function` という
  // 原因の読めない失敗になる。
  getOrganizationView: () => {
    throw new Error('getOrganizationView は section-loaders から使わない想定');
  },
}));
// モックもテナント引数を受ける（捨てると渡し忘れを検出できない）。
vi.mock('@/lib/voice/voice-store', () => ({
  getVoiceSettings: (tenantId: string) => getVoiceSettings(tenantId),
}));
vi.mock('@/lib/motion/motion-store', () => ({
  getKioskMotions: (tenantId: string) => getKioskMotions(tenantId),
}));
vi.mock('@/lib/assets/asset-store', () => ({
  getKioskAssets: (tenantId: string) => getKioskAssets(tenantId),
}));
vi.mock('@/lib/i18n/language-settings', () => ({
  getLanguageSettings: (tenantId: string) => getLanguageSettings(tenantId),
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
  getVisitorDirectory.mockResolvedValue({ departments: [], staff: [] });
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
   * **かつてテナント次元を持たなかったストア** (#419 残増分)。
   *
   * 以前は既定テナント以外を fail-closed で落としていた（安全側だが、その結果
   * **2 つ目以降のテナントは機能を使えなかった**）。全ストアがテナント別キーを持つように
   * なったので guard は撤去し、代わりに**「別テナントへ既定テナントの値を配らない」**を
   * 直接固定する。guard を消すだけだと退行に気づけない。
   */
  const tenantScopedSections = [
    'branding',
    'directory',
    'voice',
    'motions',
    'avatar',
    'languages',
  ] as const;

  it('既定テナントの要求では従来どおり値を返す', async () => {
    const loaders = createSectionLoaders();

    await expect(loaders.branding(loadInput())).resolves.toEqual({
      value: { companyName: 'AVITA', accentColor: '#123456' },
      source: 'tenant',
    });
  });

  it.each(tenantScopedSections)('%s は別テナントでも fail-closed で落ちない', async (section) => {
    const loaders = createSectionLoaders();

    await expect(loaders[section](loadInput('tenant-other'))).resolves.toBeDefined();
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

  it('テナント対応済みのセクションは別テナントで失敗せず、ストアへテナントを渡している', async () => {
    const loaders = createSectionLoaders();

    await expect(loaders.voice(loadInput('tenant-other'))).resolves.toMatchObject({
      source: 'tenant',
    });
    await expect(loaders.motions(loadInput('tenant-other'))).resolves.toBeDefined();
    await expect(loaders.avatar(loadInput('tenant-other'))).resolves.toBeDefined();
    await expect(loaders.languages(loadInput('tenant-other'))).resolves.toBeDefined();

    // 渡し忘れると既定テナントの設定が別テナントへ出る。呼び出し引数で固定する。
    expect(getVoiceSettings).toHaveBeenCalledWith('tenant-other');
    expect(getKioskMotions).toHaveBeenCalledWith('tenant-other');
    expect(getKioskAssets).toHaveBeenCalledWith('tenant-other');
    expect(getLanguageSettings).toHaveBeenCalledWith('tenant-other');
  });

  /**
   * 旧「越境要求ではストアを読みにいかない」の置き換え。**読みには行くが、必ず
   * そのテナントのキーで読む**形になったので、引数で固定する（渡し忘れると
   * 既定テナントの値が別テナントへ出る）。
   */
  it('directory も別テナントで失敗せず、ストアへテナントを渡している', async () => {
    const loaders = createSectionLoaders();

    await expect(loaders.directory(loadInput('tenant-other'))).resolves.toBeDefined();
    // scope ごと渡すようになった (#373 増分 4)。テナントが載っていることを引き続き固定する
    // （素の tenantId を落とすと越境に気づけない）。
    expect(getVisitorDirectory).toHaveBeenCalledWith({ kind: 'tenant', tenantId: 'tenant-other' });
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
