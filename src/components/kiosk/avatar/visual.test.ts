import { describe, it, expect } from 'vitest';
import { resolveAvatarVisual } from './visual';

/**
 * #196 kiosk バンドル遅延化の不変条件:
 * VRM 未設定（既定の受付画面）では VrmAvatarViewer の遅延チャンクを読み込まない。
 */
describe('resolveAvatarVisual (#196)', () => {
  it('vrmUrl があるときのみ viewer（遅延チャンクを読み込む）', () => {
    expect(resolveAvatarVisual('/models/a.vrm')).toBe('viewer');
    expect(resolveAvatarVisual('/models/a.vrm', '/img/fallback.png')).toBe('viewer');
  });

  it('vrmUrl が無く静止画があれば image（viewer チャンクは読み込まない）', () => {
    expect(resolveAvatarVisual(undefined, '/img/fallback.png')).toBe('image');
    expect(resolveAvatarVisual('', '/img/fallback.png')).toBe('image');
  });

  it('どちらも無ければ placeholder（既存の AI バッジ表示を維持）', () => {
    expect(resolveAvatarVisual()).toBe('placeholder');
    expect(resolveAvatarVisual(undefined, undefined)).toBe('placeholder');
    expect(resolveAvatarVisual('', '')).toBe('placeholder');
  });
});
