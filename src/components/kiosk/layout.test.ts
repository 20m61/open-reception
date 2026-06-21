import { describe, expect, it } from 'vitest';
import {
  KIOSK_LAYOUTS,
  LARGE_DISPLAY_MIN_WIDTH,
  resolveKioskLayout,
  type KioskLayout,
} from './layout';

describe('resolveKioskLayout', () => {
  it('iPad 縦置き（高さ > 幅）は ipad-portrait', () => {
    expect(resolveKioskLayout({ width: 810, height: 1080 })).toBe('ipad-portrait');
  });

  it('iPad 横置き（幅 >= 高さ・大型未満）は ipad-landscape', () => {
    expect(resolveKioskLayout({ width: 1080, height: 810 })).toBe('ipad-landscape');
  });

  it('幅が大型しきい値以上は向きによらず large-display（FHD/QHD/4K）', () => {
    expect(resolveKioskLayout({ width: 1920, height: 1080 })).toBe('large-display');
    expect(resolveKioskLayout({ width: 2560, height: 1440 })).toBe('large-display');
    expect(resolveKioskLayout({ width: 3840, height: 2160 })).toBe('large-display');
    // 大型は縦長でも幅で判定する。
    expect(resolveKioskLayout({ width: 2160, height: 3840 })).toBe('large-display');
  });

  it('しきい値の境界: 1600 は large-display、1599 は landscape（横長時）', () => {
    expect(resolveKioskLayout({ width: LARGE_DISPLAY_MIN_WIDTH, height: 900 })).toBe('large-display');
    expect(resolveKioskLayout({ width: LARGE_DISPLAY_MIN_WIDTH - 1, height: 900 })).toBe(
      'ipad-landscape',
    );
  });

  it('正方形（幅 == 高さ）は ipad-landscape に倒す', () => {
    expect(resolveKioskLayout({ width: 1024, height: 1024 })).toBe('ipad-landscape');
  });

  it('不正な寸法（0/負/NaN）は安全側の ipad-portrait に倒す', () => {
    expect(resolveKioskLayout({ width: 0, height: 1080 })).toBe('ipad-portrait');
    expect(resolveKioskLayout({ width: -100, height: 200 })).toBe('ipad-portrait');
    expect(resolveKioskLayout({ width: Number.NaN, height: 800 })).toBe('ipad-portrait');
    expect(resolveKioskLayout({ width: 800, height: Number.NaN })).toBe('ipad-portrait');
  });

  it('戻り値は必ず KIOSK_LAYOUTS のいずれか（網羅・排他）', () => {
    const samples: Array<{ width: number; height: number }> = [
      { width: 810, height: 1080 },
      { width: 1080, height: 810 },
      { width: 3840, height: 2160 },
      { width: 0, height: 0 },
    ];
    for (const v of samples) {
      const layout: KioskLayout = resolveKioskLayout(v);
      expect(KIOSK_LAYOUTS).toContain(layout);
    }
  });
});
