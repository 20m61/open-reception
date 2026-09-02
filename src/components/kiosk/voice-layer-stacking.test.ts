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
 *
 * #901 で層は `--z-*` トークンへ寄せた。**この検査は弱めない** —— セレクタが指す
 * トークンを `:root` まで辿って数値に解決したうえで、同じ順序を主張する。
 * 「トークンを使っているか」ではなく「順序が保たれているか」を見る、という #788 の
 * 立て方は変えていない。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync('src/app/globals.css', 'utf8');
const LAYER = readFileSync('src/components/kiosk/VoiceReadbackConfirm.tsx', 'utf8');

/** `:root` の `--z-<name>` を数値に解決する。 */
function tokenValue(name: string): number {
  const match = new RegExp(`--z-${name}\\s*:\\s*(\\d+)\\s*;`).exec(CSS);
  expect(match, `globals.css に --z-${name} が無い`).not.toBeNull();
  return Number(match?.[1]);
}

/** セレクタ直後のブロックの z-index を、トークンを辿って数値で読む。 */
function cssZIndex(selector: string): number {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `${selector} が globals.css に無い`).toBeGreaterThan(-1);
  const block = CSS.slice(at, CSS.indexOf('}', at));
  const match = block.match(/z-index:\s*var\(--z-([a-z0-9-]+)\)/);
  expect(match, `${selector} の z-index が --z-* トークンで書かれていない`).not.toBeNull();
  return tokenValue(String(match?.[1]));
}

function voiceLayerZIndex(): number {
  const match = LAYER.match(/zIndex:\s*zIndex\.([A-Za-z]+)/);
  expect(match, 'VoiceReadbackConfirm の zIndex がトークンで書かれていない').not.toBeNull();
  // `zIndex.voice` → `--z-voice`。camelCase は kebab-case へ倒す。
  const kebab = String(match?.[1]).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return tokenValue(kebab);
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
