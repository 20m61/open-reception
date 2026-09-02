import { describe, expect, it } from 'vitest';
import { PERSISTENT_REGIONS } from '@/domain/reception/ui-contract';
import { PERSISTENT_ELEMENTS, regionOfElement } from './persistent-regions';

describe('kiosk persistent-regions: 常設要素の登録簿 (#422 inc5-c 増分 2)', () => {
  it('すべての常設要素が 3 領域のいずれかに属する', () => {
    // #422 の AC「常設要素を原則 3 領域以内へ整理」。領域外の常設要素を作らない。
    for (const element of PERSISTENT_ELEMENTS) {
      expect(PERSISTENT_REGIONS, element.testId).toContain(element.region);
    }
  });

  it('testId が重複しない（同じ要素を二重に登録しない）', () => {
    const ids = PERSISTENT_ELEMENTS.map((e) => e.testId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ヘルプ領域に集まるのは行き詰まりの手段だけ', () => {
    // 逃げ道・チャット・アクセシビリティ・言語切替・退館。前進の CTA は含めない
    // （代替の連絡先へ＝useFallback は結果画面の主 CTA で、回答対象であってヘルプではない）。
    const help = PERSISTENT_ELEMENTS.filter((e) => e.region === 'help').map((e) => e.testId);
    expect(help).toEqual([
      'kiosk-escape-bar',
      // QR 受付シェルの後退導線 (#361 AC2)。受付と同じ語彙・同じボタンを出すが、表示可否を
      // 決めるのが checkin 状態機械側の契約なので登録は別（`key` を持たない）。
      'checkin-escape-bar',
      'kiosk-chat-drawer',
      'a11y-menu-button',
      'kiosk-language-switcher',
      'kiosk-checkout-link',
    ]);
  });

  it('案内領域はアバターと音声字幕（来訪者へ状況を伝えるもの）', () => {
    const guidance = PERSISTENT_ELEMENTS.filter((e) => e.region === 'guidance').map((e) => e.testId);
    expect(guidance).toEqual(['kiosk-avatar-companion', 'voice-layer']);
  });

  it('登録済みの testId から領域を引ける／未登録は null', () => {
    expect(regionOfElement('kiosk-escape-bar')).toBe('help');
    expect(regionOfElement('kiosk-avatar-companion')).toBe('guidance');
    // 未登録の要素に領域を推測で与えない（登録簿が唯一の権威）。
    expect(regionOfElement('not-registered')).toBeNull();
  });
});
