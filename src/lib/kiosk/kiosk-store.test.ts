import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetKiosks,
  createKiosk,
  getKioskConfig,
  listKiosks,
  setKioskEnabled,
} from './kiosk-store';

beforeEach(async () => {
  await __resetKiosks();
});

describe('kiosk-store (#18)', () => {
  it('seed 端末を一覧できる', async () => {
    expect((await listKiosks()).some((k) => k.id === 'kiosk-dev')).toBe(true);
  });

  it('端末を登録できる', async () => {
    const r = await createKiosk({ displayName: '受付端末2', location: '2F' });
    expect(r.ok).toBe(true);
    if (r.ok) expect((await listKiosks()).some((k) => k.id === r.value.id)).toBe(true);
  });

  it('端末名が空なら拒否する', async () => {
    expect((await createKiosk({ displayName: '' })).ok).toBe(false);
  });

  it('有効な端末の config は active=true', async () => {
    expect((await getKioskConfig('kiosk-dev')).active).toBe(true);
  });

  it('失効した端末の config は active=false', async () => {
    await setKioskEnabled('kiosk-dev', false);
    expect((await getKioskConfig('kiosk-dev')).active).toBe(false);
  });

  it('未登録端末の config は active=false', async () => {
    const config = await getKioskConfig('unknown');
    expect(config.active).toBe(false);
    expect(config.displayName).toBeUndefined();
  });

  it('再有効化できる', async () => {
    await setKioskEnabled('kiosk-dev', false);
    await setKioskEnabled('kiosk-dev', true);
    expect((await getKioskConfig('kiosk-dev')).active).toBe(true);
  });

  it('存在しない端末の更新は not_found', async () => {
    const r = await setKioskEnabled('nope', false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_found');
  });
});
