import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetAssets,
  createAsset,
  getKioskAssets,
  listAssets,
  setActiveAsset,
  setAssetEnabled,
} from './asset-store';
import { validateAsset } from '@/domain/assets/types';

beforeEach(() => {
  __resetAssets();
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
  it('seed の背景が適用中', () => {
    expect(getKioskAssets().backgroundUrl).toBe('/assets/default-bg.png');
  });

  it('アセットを登録できる', () => {
    const r = createAsset({ kind: 'background', name: 'イベント背景', url: 'https://cdn/x.jpg' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(listAssets('background').some((a) => a.id === r.value.id)).toBe(true);
  });

  it('不正な形式を拒否', () => {
    const r = createAsset({ kind: 'vrm', name: 'bad', url: 'bad.txt' });
    expect(r.ok).toBe(false);
  });

  it('アクティブ背景を切り替えられる', () => {
    const created = createAsset({ kind: 'background', name: 'new', url: 'https://cdn/n.png' });
    if (!created.ok) return;
    setActiveAsset(created.value.id);
    expect(getKioskAssets().backgroundUrl).toBe('https://cdn/n.png');
  });

  it('無効なアセットは適用できない', () => {
    const created = createAsset({ kind: 'background', name: 'd', url: 'https://cdn/d.png' });
    if (!created.ok) return;
    setAssetEnabled(created.value.id, false);
    expect(setActiveAsset(created.value.id).ok).toBe(false);
  });

  it('適用中アセットを無効化すると適用解除される', () => {
    setAssetEnabled('asset-bg-default', false);
    expect(getKioskAssets().backgroundUrl).toBeUndefined();
  });
});
