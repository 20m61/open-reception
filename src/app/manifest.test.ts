import { describe, expect, it } from 'vitest';
import manifest from './manifest';

/**
 * Web App Manifest のフィールド検証 (issue #331)。
 * `next build` が実際の `/manifest.webmanifest` ルート応答を検証するため、
 * ここでは manifest() が返す純粋なオブジェクトの内容（installability の受け入れ条件）
 * のみを対象にする。
 */
describe('manifest (#331)', () => {
  it('standalone 表示・kiosk 起点の start_url を持つ', () => {
    const m = manifest();
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/kiosk');
    expect(m.scope).toBe('/');
  });

  it('name/short_name/description が設定されている', () => {
    const m = manifest();
    expect(m.name).toBe('open-reception');
    expect(m.short_name).toBeTruthy();
    expect(m.description).toBeTruthy();
  });

  it('theme_color/background_color がデザイントークン（root layout の viewport.themeColor 等）と一致する', () => {
    const m = manifest();
    expect(m.theme_color).toBe('#0f172a');
    expect(m.background_color).toBe('#0b1120');
  });

  it('orientation は特定方向へ固定しない', () => {
    expect(manifest().orientation).toBe('any');
  });

  it('192px 以上の PNG アイコンを any/maskable 両方の purpose で持つ（installability 要件）', () => {
    const icons = manifest().icons ?? [];
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      expect(icon.type).toBe('image/png');
      const [w, h] = (icon.sizes ?? '0x0').split('x').map(Number);
      expect(w).toBeGreaterThanOrEqual(192);
      expect(h).toBeGreaterThanOrEqual(192);
    }
    const purposes = icons.map((icon) => icon.purpose);
    expect(purposes).toContain('any');
    expect(purposes).toContain('maskable');
  });
});
