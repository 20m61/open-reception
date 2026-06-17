import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetKiosks,
  createKiosk,
  getKioskConfig,
  listKiosks,
  setKioskEnabled,
} from './kiosk-store';

beforeEach(() => {
  __resetKiosks();
});

describe('kiosk-store (#18)', () => {
  it('seed 端末を一覧できる', () => {
    expect(listKiosks().some((k) => k.id === 'kiosk-dev')).toBe(true);
  });

  it('端末を登録できる', () => {
    const r = createKiosk({ displayName: '受付端末2', location: '2F' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(listKiosks().some((k) => k.id === r.value.id)).toBe(true);
  });

  it('端末名が空なら拒否する', () => {
    expect(createKiosk({ displayName: '' }).ok).toBe(false);
  });

  it('有効な端末の config は active=true', () => {
    expect(getKioskConfig('kiosk-dev').active).toBe(true);
  });

  it('失効した端末の config は active=false', () => {
    setKioskEnabled('kiosk-dev', false);
    expect(getKioskConfig('kiosk-dev').active).toBe(false);
  });

  it('未登録端末の config は active=false', () => {
    const config = getKioskConfig('unknown');
    expect(config.active).toBe(false);
    expect(config.displayName).toBeUndefined();
  });

  it('再有効化できる', () => {
    setKioskEnabled('kiosk-dev', false);
    setKioskEnabled('kiosk-dev', true);
    expect(getKioskConfig('kiosk-dev').active).toBe(true);
  });

  it('存在しない端末の更新は not_found', () => {
    const r = setKioskEnabled('nope', false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not_found');
  });
});
