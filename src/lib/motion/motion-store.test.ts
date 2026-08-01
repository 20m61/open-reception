import { beforeEach, describe, expect, it } from 'vitest';
import { __resetMotions, getKioskMotions, getMotionMapping, setMotion } from './motion-store';

const T = 'internal';
import { __resetAssets, createAsset } from '@/lib/assets/asset-store';

beforeEach(async () => {
  await __resetAssets();
  await __resetMotions();
});

async function addMotionAsset() {
  const r = await createAsset(T, { kind: 'motion', name: '挨拶モーション', url: 'https://cdn/greet.vrma' });
  if (!r.ok) throw new Error('asset create failed');
  return r.value.id;
}

describe('motion-store (#31)', () => {
  it('モーションアセットを状態キーに割り当てられる', async () => {
    const id = await addMotionAsset();
    const r = await setMotion(T, 'greeting', id);
    expect(r.ok).toBe(true);
    expect((await getMotionMapping(T)).mapping.greeting).toBe(id);
  });

  it('モーション以外/不明なアセットは拒否する', async () => {
    expect((await setMotion(T, 'idle', 'unknown')).ok).toBe(false);
  });

  it('不正なモーションキーは拒否する', async () => {
    const id = await addMotionAsset();
    expect((await setMotion(T, 'bogus', id)).ok).toBe(false);
  });

  it('null で割り当てを解除できる', async () => {
    const id = await addMotionAsset();
    await setMotion(T, 'greeting', id);
    await setMotion(T, 'greeting', null);
    expect((await getMotionMapping(T)).mapping.greeting).toBeUndefined();
  });

  it('kiosk 向けにキー→URL を解決する', async () => {
    const id = await addMotionAsset();
    await setMotion(T, 'greeting', id);
    expect((await getKioskMotions(T)).motions.greeting).toBe('https://cdn/greet.vrma');
  });
});

/** テナント別に分離されていること (#419 残増分)。 */
describe('motion-store のテナント分離 (#419)', () => {
  it('別テナントの割り当ては混ざらない', async () => {
    await __resetMotions('acme');
    const assetId = await addMotionAsset();
    await setMotion(T, 'idle', assetId);

    // 既定テナントには割り当てたが、別テナントには波及しない。
    expect((await getMotionMapping(T)).mapping.idle).toBe(assetId);
    expect((await getMotionMapping('acme')).mapping).toEqual({});
  });
});
