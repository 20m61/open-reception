/**
 * 音声レイヤの重ね順 (#788)。
 *
 * 復唱の「はい／いいえ」は**操作カードより前**（でないとカードに覆われて押せない）かつ
 * **逃げ道バーより後ろ**（でないと「戻る」を隠す）でなければならない。さらに、来訪者を
 * 止めるための重ね（無操作警告・アクセシビリティメニュー）を侵してはいけない。
 *
 * 🔴 **上限が縛られていなかった。** `zIndex` を 25 → 100 にする変異は unit 861 件でも e2e でも
 * 素通りし、実測ではアクセシビリティメニューを開いた状態で**モーダルの上に復唱ボタンが乗った**。
 * 「値が付いているか」ではなく「順序が保たれているか」を縛る。
 *
 * 値は globals.css と `VoiceReadbackConfirm` の inline style に分かれて置かれているので、
 * ここで突き合わせる（順序はどちらか一方だけを見ても分からない）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync('src/app/globals.css', 'utf8');
const LAYER = readFileSync('src/components/kiosk/VoiceReadbackConfirm.tsx', 'utf8');

/** セレクタ直後のブロックから z-index を読む。 */
function cssZIndex(selector: string): number {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `${selector} が globals.css に無い`).toBeGreaterThan(-1);
  const block = CSS.slice(at, CSS.indexOf('}', at));
  const match = block.match(/z-index:\s*(\d+)/);
  expect(match, `${selector} に z-index が無い`).not.toBeNull();
  return Number(match?.[1]);
}

function voiceLayerZIndex(): number {
  const match = LAYER.match(/zIndex:\s*(\d+)/);
  expect(match, 'VoiceReadbackConfirm に zIndex が無い').not.toBeNull();
  return Number(match?.[1]);
}

describe('音声レイヤの重ね順 (#788)', () => {
  it('操作カード（アバター）より前・逃げ道バーより後ろ', () => {
    const voice = voiceLayerZIndex();
    expect(voice).toBeGreaterThan(cssZIndex('.kiosk-avatar-companion'));
    expect(voice).toBeLessThan(cssZIndex('.kiosk-escape-bar'));
  });

  /** 来訪者を止める重ねを侵さない（開いているモーダルの上に復唱が乗らない）。 */
  it('無操作警告・アクセシビリティメニューより後ろ', () => {
    const voice = voiceLayerZIndex();
    expect(voice).toBeLessThan(cssZIndex('.a11y-menu__button'));
    expect(voice).toBeLessThan(cssZIndex('.inactivity-overlay'));
    expect(voice).toBeLessThan(cssZIndex('.a11y-menu__overlay'));
  });
});
