import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 高コントラストのパレットが 2 箇所で食い違わないようにする (#907 / 課題 32)。
 *
 * 高コントラストには入口が 2 つある —— 受付端末の支援モード
 * （`.screen[data-a11y-contrast='high']`）と、OS 設定（`@media (prefers-contrast: more)`）。
 * CSS では宣言ブロックを共有できないので値を二重に書くしかない。
 *
 * 🔴 このリポジトリで繰り返し出ているのは**「ある次元で解いた対策を別の次元へ写していない」**
 * 型の欠陥である（#870 platform→admin / #884 #869→accent / #886 kiosk→admin /
 * #890 AdminShell→DevicesManager）。片方だけ更新した瞬間に、OS 設定で来た利用者だけが
 * 古いパレットを見る。**散文の約束ではなく、ここで突き合わせる。**
 */

const CSS = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

/** 指定位置から始まる宣言ブロックの `--var: value;` を map で返す。 */
function declarations(from: number): Record<string, string> {
  const open = CSS.indexOf('{', from);
  const close = CSS.indexOf('}', open);
  const body = CSS.slice(open + 1, close);
  return Object.fromEntries(
    [...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [
      String(m[1]),
      String(m[2]).trim(),
    ]),
  );
}

function kioskPalette(): Record<string, string> {
  const at = CSS.indexOf(".screen[data-a11y-contrast='high'] {");
  expect(at, '受付端末の HC パレットが見つからない').toBeGreaterThan(-1);
  return declarations(at);
}

function osPalette(): Record<string, string> {
  const media = CSS.indexOf('@media (prefers-contrast: more)');
  expect(media, 'prefers-contrast のブロックが無い').toBeGreaterThan(-1);
  const root = CSS.indexOf(':root', media);
  expect(root, 'prefers-contrast 内に :root が無い').toBeGreaterThan(-1);
  return declarations(root);
}

describe('高コントラストのパレット一致 (#907 / 課題 32)', () => {
  it('2 つの入口が同じ変数を上書きする', () => {
    expect(Object.keys(osPalette()).sort()).toEqual(Object.keys(kioskPalette()).sort());
  });

  it('2 つの入口が同じ値を与える', () => {
    const kiosk = kioskPalette();
    for (const [name, value] of Object.entries(osPalette())) {
      expect(value, `${name} が 2 つの入口で違う`).toBe(kiosk[name]);
    }
  });

  /*
   * 下界。上の 2 本は「両方を空にする」で通る（0 件ループ + 空集合の一致）。
   * パレットが実体を持つことと、地色が変数を経由していることを縛る。
   */
  it('下界: パレットが実体を持つ', () => {
    expect(Object.keys(kioskPalette()).length).toBeGreaterThanOrEqual(10);
  });

  it('下界: 状態の地色が生 rgba でなく変数から導かれる', () => {
    /*
     * HC はパレット（CSS 変数）を差し替えるだけなので、**変数を経由しない地色には届かない**。
     * `.notice--*` と `.result-panel__icon` は実際にそれで取り残されていた ——
     * 枠と文字だけが切り替わり、地色が残る。
     */
    const offenders = [
      '.notice--success',
      '.notice--danger',
      '.notice--warning',
      '.result-panel--success .result-panel__icon',
      '.result-panel--danger .result-panel__icon',
      '.result-panel--warning .result-panel__icon',
    ].filter((selector) => {
      const at = CSS.indexOf(`${selector} {`);
      expect(at, `${selector} が globals.css に無い`).toBeGreaterThan(-1);
      const body = CSS.slice(at, CSS.indexOf('}', at));
      return /background:\s*rgba?\(/.test(body);
    });
    expect(offenders).toEqual([]);
  });

  it('OS の強制配色に明け渡す（自前パレットを重ねない）', () => {
    const at = CSS.indexOf('@media (forced-colors: active)');
    expect(at, 'forced-colors のブロックが無い').toBeGreaterThan(-1);
    const body = CSS.slice(at, CSS.indexOf('\n}\n', CSS.indexOf('outline', at)));
    // 操作できるものの輪郭を残す（面だけで押せると示している要素が消えないように）。
    expect(body).toContain('ButtonText');
    expect(body).toContain('Highlight');
    // 下界: 自前の hex を重ねない（OS が選んだ色を上書きしない）。
    expect(/#[0-9a-fA-F]{6}/.test(body), 'forced-colors 内で自前の色を指定している').toBe(false);
  });
});
