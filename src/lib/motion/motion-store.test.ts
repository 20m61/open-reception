import { beforeEach, describe, expect, it } from 'vitest';
import { __resetMotions, getKioskMotions, getMotionMapping, setMotion } from './motion-store';
import { __resetAssets, createAsset } from '@/lib/assets/asset-store';

beforeEach(async () => {
  await __resetAssets();
  await __resetMotions();
});

async function addMotionAsset() {
  const r = await createAsset({ kind: 'motion', name: '挨拶モーション', url: 'https://cdn/greet.vrma' });
  if (!r.ok) throw new Error('asset create failed');
  return r.value.id;
}

describe('motion-store (#31)', () => {
  it('モーションアセットを状態キーに割り当てられる', async () => {
    const id = await addMotionAsset();
    const r = await setMotion('greeting', id);
    expect(r.ok).toBe(true);
    expect((await getMotionMapping()).mapping.greeting).toBe(id);
  });

  it('モーション以外/不明なアセットは拒否する', async () => {
    expect((await setMotion('idle', 'unknown')).ok).toBe(false);
  });

  it('不正なモーションキーは拒否する', async () => {
    const id = await addMotionAsset();
    expect((await setMotion('bogus', id)).ok).toBe(false);
  });

  it('null で割り当てを解除できる', async () => {
    const id = await addMotionAsset();
    await setMotion('greeting', id);
    await setMotion('greeting', null);
    expect((await getMotionMapping()).mapping.greeting).toBeUndefined();
  });

  it('kiosk 向けにキー→URL を解決する', async () => {
    const id = await addMotionAsset();
    await setMotion('greeting', id);
    expect((await getKioskMotions()).motions.greeting).toBe('https://cdn/greet.vrma');
  });
});
