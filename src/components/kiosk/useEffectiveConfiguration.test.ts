/**
 * 実効構成の一括取得（写像・取得）の単体テスト (issue #422 increment 1)。
 *
 * フック本体は DOM 依存のため、純関数 `selectKioskConfiguration` と
 * `loadEffectiveConfiguration`（fetch 注入）を検証する。**旧経路（個別 API 7 本）と同じ値に
 * 落ちること**が本増分の要件なので、各セクションの写像を 1 つずつ固定する。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  EFFECTIVE_CONFIGURATION_PATH,
  loadEffectiveConfiguration,
  selectKioskConfiguration,
} from './useEffectiveConfiguration';

/** `/api/configuration/effective` の応答（全セクション埋まった状態）。 */
function payload(overrides: Record<string, unknown> = {}) {
  return {
    context: { tenantId: 'default', siteId: 'default-site', kioskId: 'kiosk-1' },
    version: { id: 'exp-1#3', status: 'published', revision: 3, contentHash: 'sha256:content' },
    directory: {
      departments: [{ id: 'd1', name: '総務部' }],
      staff: [
        {
          id: 's1',
          displayName: '佐藤',
          kana: 'さとう',
          aliases: [],
          departmentId: 'd1',
          available: true,
        },
      ],
    },
    voice: {
      guidanceIdle: 'ようこそ',
      privacyNotice: '入力内容は受付にのみ使います',
      ttsEnabled: true,
      sttEnabled: true,
      rate: 1.2,
      volume: 0.8,
      language: 'ja-JP',
      callingStageWaitingAfterMs: 5000,
      callingStageNoticeAfterMs: 15000,
      guidanceCallingWaiting: 'お待ちください',
      guidanceCallingNotice: 'まもなく切り替わります',
      feedbackEnabled: false,
      a11yModesEnabled: { largeText: true, highContrast: false, lowReach: true, simpleJapanese: false },
    },
    avatar: { backgroundUrl: '/bg.png', vrmUrl: '/a.vrm', fallbackImageUrl: '/a.png' },
    branding: { companyName: 'オープン株式会社', accentColor: '#123456', logoUrl: '/logo.png' },
    motions: { motions: { idle: '/idle.vrma' }, defaultUrl: '/default.vrma' },
    receptionFlow: { flows: [{ id: 'f1', name: '来客', fields: [] }] },
    signage: { enabled: true, defaultIntervalSeconds: 10, items: [{ type: 'text' }, { type: 'text' }] },
    integrations: {},
    featureFlags: { avatarReception: true },
    provenance: { directory: 'tenant', branding: 'tenant' },
    configHash: 'sha256:with-context',
    generatedAt: '2026-07-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('selectKioskConfiguration', () => {
  it('全セクションを画面が使う形へ写す', () => {
    const selected = selectKioskConfiguration(payload());
    expect(selected).not.toBeNull();
    const { sections, meta } = selected!;

    expect(sections.directory?.departments).toHaveLength(1);
    expect(sections.directory?.staff[0]?.displayName).toBe('佐藤');
    expect(sections.voice).toEqual({
      guidanceIdle: 'ようこそ',
      privacyNotice: '入力内容は受付にのみ使います',
      sttEnabled: true,
      speak: { ttsEnabled: true, rate: 1.2, volume: 0.8, language: 'ja-JP' },
      callingStageThresholds: { waitingAfterMs: 5000, noticeAfterMs: 15000 },
      callingStageText: { waiting: 'お待ちください', notice: 'まもなく切り替わります' },
      feedbackEnabled: false,
      a11yEnabledModes: {
        largeText: true,
        highContrast: false,
        lowReach: true,
        simpleJapanese: false,
      },
    });
    expect(sections.avatar).toEqual({
      backgroundUrl: '/bg.png',
      vrmUrl: '/a.vrm',
      fallbackImageUrl: '/a.png',
    });
    expect(sections.branding).toEqual({
      companyName: 'オープン株式会社',
      accentColor: '#123456',
      logoUrl: '/logo.png',
    });
    expect(sections.motions).toEqual({ motions: { idle: '/idle.vrma' }, defaultUrl: '/default.vrma' });
    expect(sections.flows).toHaveLength(1);
    expect(sections.signageCount).toBe(2);

    // 反映状況の報告（#420）に使うのは内容の指紋 contentHash であって configHash ではない。
    expect(meta).toMatchObject({
      versionId: 'exp-1#3',
      revision: 3,
      contentHash: 'sha256:content',
      configHash: 'sha256:with-context',
    });
  });

  it('音声設定の未設定値は旧経路と同じ既定へ落ちる', () => {
    const selected = selectKioskConfiguration(payload({ voice: {} }));
    expect(selected!.sections.voice).toEqual({
      guidanceIdle: undefined,
      privacyNotice: undefined,
      sttEnabled: false,
      speak: { ttsEnabled: false, rate: 1, volume: 1, language: 'ja-JP' },
      callingStageThresholds: { waitingAfterMs: undefined, noticeAfterMs: undefined },
      callingStageText: { waiting: undefined, notice: undefined },
      // 未設定なら満足度収集は「する」（#320 の既定）。
      feedbackEnabled: true,
      a11yEnabledModes: {
        largeText: true,
        highContrast: true,
        lowReach: true,
        simpleJapanese: true,
      },
    });
  });

  it('アバター機能無効時（motions が空集合）でも空で継続する', () => {
    const selected = selectKioskConfiguration(payload({ motions: { motions: {} } }));
    expect(selected!.sections.motions).toEqual({ motions: {}, defaultUrl: undefined });
  });

  it('カスタムフローが無ければ空配列（既定フローへ倒す）', () => {
    expect(selectKioskConfiguration(payload({ receptionFlow: {} }))!.sections.flows).toEqual([]);
    expect(
      selectKioskConfiguration(payload({ receptionFlow: { flows: [] } }))!.sections.flows,
    ).toEqual([]);
  });

  it('サイネージ項目が無ければ 0 件（既定の待機画面）', () => {
    expect(selectKioskConfiguration(payload({ signage: { enabled: false } }))!.sections.signageCount)
      .toBe(0);
  });

  it('欠落・型不正のセクションは undefined にして、そのセクションだけ既定を維持させる', () => {
    const broken = selectKioskConfiguration(
      payload({
        directory: null,
        voice: 'nope',
        avatar: [],
        branding: undefined,
        motions: 42,
        receptionFlow: null,
        signage: null,
      }),
    );
    expect(broken!.sections).toEqual({
      directory: undefined,
      voice: undefined,
      avatar: undefined,
      branding: undefined,
      motions: undefined,
      flows: undefined,
      signageCount: undefined,
    });
  });

  it('directory は departments/staff が配列でなければ未取得扱い', () => {
    expect(
      selectKioskConfiguration(payload({ directory: { departments: [], staff: 'x' } }))!.sections
        .directory,
    ).toBeUndefined();
  });

  it('payload 自体が object でなければ null', () => {
    expect(selectKioskConfiguration(null)).toBeNull();
    expect(selectKioskConfiguration('{}')).toBeNull();
    expect(selectKioskConfiguration([])).toBeNull();
  });
});

describe('loadEffectiveConfiguration', () => {
  const okResponse = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

  it('スコープ query を付けずに 1 回だけ取得する（越境の入口を作らない）', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse(payload()));
    const result = await loadEffectiveConfiguration(fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(EFFECTIVE_CONFIGURATION_PATH);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store' });
    expect(result.status).toBe('ready');
  });

  it('403（未エンロール端末など）は error として返し、既定値を「取得成功」に見せない', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => ({ ok: false, status: 403, json: async () => ({}) }) as unknown as Response,
    );
    expect(await loadEffectiveConfiguration(fetchImpl)).toEqual({
      status: 'error',
      httpStatus: 403,
    });
  });

  it('503（セクション取得不能）も error（部分構成で受付を続けない）', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        ({ ok: false, status: 503, json: async () => ({ error: 'section_unavailable' }) }) as unknown as Response,
    );
    expect(await loadEffectiveConfiguration(fetchImpl)).toEqual({
      status: 'error',
      httpStatus: 503,
    });
  });

  it('通信断・JSON 不正は error（例外を投げない）', async () => {
    const throwing = vi.fn<typeof fetch>(async () => {
      throw new Error('network');
    });
    expect(await loadEffectiveConfiguration(throwing)).toEqual({
      status: 'error',
    });

    const badJson = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('unexpected token');
          },
        }) as unknown as Response,
    );
    expect(await loadEffectiveConfiguration(badJson)).toEqual({
      status: 'error',
    });
  });

  it('object でない応答本文も error', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse('not-an-object'));
    expect(await loadEffectiveConfiguration(fetchImpl)).toEqual({
      status: 'error',
      httpStatus: 200,
    });
  });
});
