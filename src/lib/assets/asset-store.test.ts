import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetAssets,
  createAsset,
  defaultVrmUrl,
  getKioskAssets,
  listAssets,
  setActiveAsset,
  setAssetEnabled,
} from './asset-store';
import { validateAsset } from '@/domain/assets/types';

beforeEach(async () => {
  await __resetAssets();
});

describe('defaultVrmUrl (#31)', () => {
  it('未設定なら undefined', () => {
    expect(defaultVrmUrl({})).toBeUndefined();
  });

  it('設定値をそのまま返す', () => {
    expect(defaultVrmUrl({ KIOSK_DEFAULT_VRM_URL: '/avatar/default.vrm' })).toBe('/avatar/default.vrm');
  });

  it('空 / none / off で無効化できる', () => {
    expect(defaultVrmUrl({ KIOSK_DEFAULT_VRM_URL: '' })).toBeUndefined();
    expect(defaultVrmUrl({ KIOSK_DEFAULT_VRM_URL: '  ' })).toBeUndefined();
    expect(defaultVrmUrl({ KIOSK_DEFAULT_VRM_URL: 'none' })).toBeUndefined();
    expect(defaultVrmUrl({ KIOSK_DEFAULT_VRM_URL: 'off' })).toBeUndefined();
  });
});

describe('getKioskAssets VRM 既定 (#31)', () => {
  const original = process.env.KIOSK_DEFAULT_VRM_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.KIOSK_DEFAULT_VRM_URL;
    else process.env.KIOSK_DEFAULT_VRM_URL = original;
  });

  it('VRM 未登録時は環境変数の既定モデルへ fallback する', async () => {
    process.env.KIOSK_DEFAULT_VRM_URL = '/avatar/default.vrm';
    expect((await getKioskAssets()).vrmUrl).toBe('/avatar/default.vrm');
  });

  it('登録済み VRM は既定より優先される', async () => {
    process.env.KIOSK_DEFAULT_VRM_URL = '/avatar/default.vrm';
    const created = await createAsset({ kind: 'vrm', name: 'カスタム', url: 'https://cdn/custom.vrm' });
    expect(created.ok).toBe(true);
    if (created.ok) await setActiveAsset(created.value.id);
    expect((await getKioskAssets()).vrmUrl).toBe('https://cdn/custom.vrm');
  });
});

describe('validateAsset (#27)', () => {
  it('背景は画像拡張子のみ許可', () => {
    expect(validateAsset('background', 'bg.png')).toBeNull();
    expect(validateAsset('background', 'model.vrm')).not.toBeNull();
  });
  it('VRM は .vrm のみ許可', () => {
    expect(validateAsset('vrm', 'avatar.vrm')).toBeNull();
    expect(validateAsset('vrm', 'avatar.png')).not.toBeNull();
  });
  it('サイズ超過を拒否', () => {
    expect(validateAsset('background', 'bg.png', 999 * 1024 * 1024)).not.toBeNull();
  });
});

describe('asset-store (#27)', () => {
  it('seed の背景が適用中', async () => {
    expect((await getKioskAssets()).backgroundUrl).toBe('/assets/default-bg.png');
  });

  it('アセットを登録できる', async () => {
    const r = await createAsset({ kind: 'background', name: 'イベント背景', url: 'https://cdn/x.jpg' });
    expect(r.ok).toBe(true);
    if (r.ok) expect((await listAssets('background')).some((a) => a.id === r.value.id)).toBe(true);
  });

  it('不正な形式を拒否', async () => {
    const r = await createAsset({ kind: 'vrm', name: 'bad', url: 'bad.txt' });
    expect(r.ok).toBe(false);
  });

  it('アクティブ背景を切り替えられる', async () => {
    const created = await createAsset({ kind: 'background', name: 'new', url: 'https://cdn/n.png' });
    if (!created.ok) return;
    await setActiveAsset(created.value.id);
    expect((await getKioskAssets()).backgroundUrl).toBe('https://cdn/n.png');
  });

  it('無効なアセットは適用できない', async () => {
    const created = await createAsset({ kind: 'background', name: 'd', url: 'https://cdn/d.png' });
    if (!created.ok) return;
    await setAssetEnabled(created.value.id, false);
    expect((await setActiveAsset(created.value.id)).ok).toBe(false);
  });

  it('適用中アセットを無効化すると適用解除される', async () => {
    await setAssetEnabled('asset-bg-default', false);
    expect((await getKioskAssets()).backgroundUrl).toBeUndefined();
  });
});
