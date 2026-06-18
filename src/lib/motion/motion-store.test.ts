import { beforeEach, describe, expect, it } from 'vitest';
import { __resetMotions, getKioskMotions, getMotionMapping, setMotion } from './motion-store';
import { __resetAssets, createAsset } from '@/lib/assets/asset-store';

beforeEach(() => {
  __resetAssets();
  __resetMotions();
});

function addMotionAsset() {
  const r = createAsset({ kind: 'motion', name: '挨拶モーション', url: 'https://cdn/greet.vrma' });
  if (!r.ok) throw new Error('asset create failed');
  return r.value.id;
}

describe('motion-store (#31)', () => {
  it('モーションアセットを状態キーに割り当てられる', () => {
    const id = addMotionAsset();
    const r = setMotion('greeting', id);
    expect(r.ok).toBe(true);
    expect(getMotionMapping().mapping.greeting).toBe(id);
  });

  it('モーション以外/不明なアセットは拒否する', () => {
    expect(setMotion('idle', 'unknown').ok).toBe(false);
  });

  it('不正なモーションキーは拒否する', () => {
    const id = addMotionAsset();
    expect(setMotion('bogus', id).ok).toBe(false);
  });

  it('null で割り当てを解除できる', () => {
    const id = addMotionAsset();
    setMotion('greeting', id);
    setMotion('greeting', null);
    expect(getMotionMapping().mapping.greeting).toBeUndefined();
  });

  it('kiosk 向けにキー→URL を解決する', () => {
    const id = addMotionAsset();
    setMotion('greeting', id);
    expect(getKioskMotions().motions.greeting).toBe('https://cdn/greet.vrma');
  });
});
