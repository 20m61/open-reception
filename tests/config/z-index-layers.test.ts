import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { zIndex } from '@/components/admin/ui/tokens';

/**
 * 重ね順の**意味**を縛る (#901 / 課題 29)。
 *
 * 値の一致は `ui/tokens-css-parity.test.ts` が、音声レイヤの順序は
 * `src/components/kiosk/voice-layer-stacking.test.ts` が見ている。ここが見るのは
 * **層が増えたときに壊れる不変条件**の方:
 *
 * 1. 生の数値で層を書き足せない（3 つの記述系に散っていたのが元の状態）
 * 2. 同時に画面へ出る層が同値にならない
 *
 * 2 は実害があった —— `--z-sidebar` と管理画面のモーダル背面がどちらも 50 で、
 * 正しく描けていたのは `AdminShell` が sidebar を `{children}` より**前**に置いており
 * 同値なら DOM 順で後が勝つ、という**偶然**による。どちらかの DOM 位置が動いた瞬間に、
 * 受付 URL を表示しているモーダルがサイドバーの下へ潜る。
 */

const SRC = join(process.cwd(), 'src');

function sources(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    if (!e.isFile() || !/\.(tsx?|css)$/.test(e.name)) return [];
    return e.name.includes('.test.') ? [] : [path];
  });
}

/**
 * 同時に画面へ出うる層のまとまり。**別の area は同値でよい**（受付端末のチャット
 * ドロワーと管理画面のスクリムは同時に描画されない）ので、area を分けて数える。
 */
const AREAS: Readonly<Record<string, readonly (keyof typeof zIndex)[]>> = {
  kiosk: ['behind', 'companion', 'voice', 'escapeBar', 'chatDrawer', 'a11yButton', 'inactivity', 'a11yOverlay'],
  admin: ['scrim', 'sidebar', 'dialog'],
};

describe('重ね順の不変条件 (#901 / 課題 29)', () => {
  it('生の数値で層を書かない（トークン経由だけ）', () => {
    const offenders = sources().flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return [
        ...[...source.matchAll(/z-index:\s*(-?\d+)/g)].map((m) => m[0]),
        ...[...source.matchAll(/zIndex:\s*(-?\d+)/g)].map((m) => m[0]),
      ].map((hit) => `${relative(SRC, path)}: ${hit}`);
    });
    expect(offenders).toEqual([]);
  });

  it.each(Object.entries(AREAS))('%s: 同時に出る層が同値にならない', (_area, layers) => {
    const values = layers.map((key) => zIndex[key]);
    expect(new Set(values).size).toBe(values.length);
  });

  /*
   * 下界。上の 2 本は「層を全部消す」「area の表を空にする」で通る。
   * 実際に層が居ることと、area の表が全部の層を覆っていることを縛る。
   */
  it('下界: すべての層がいずれかの area に属する', () => {
    const covered = new Set(Object.values(AREAS).flat());
    expect(Object.keys(zIndex).filter((k) => !covered.has(k as keyof typeof zIndex))).toEqual([]);
    expect(Object.keys(zIndex).length).toBeGreaterThan(0);
  });

  it('下界: 層は実際にトークン経由で参照されている', () => {
    const referenced = sources().flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return [
        ...[...source.matchAll(/z-index:\s*var\(--z-([a-z0-9-]+)\)/g)].map((m) => m[1]),
        ...[...source.matchAll(/zIndex:\s*zIndex\.([A-Za-z0-9]+)/g)].map((m) =>
          String(m[1]).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
        ),
      ];
    });
    // 12 箇所を移行した。減ったら「層が生の数値へ戻った」か「層が消えた」。
    expect(new Set(referenced).size).toBeGreaterThanOrEqual(8);
  });
});
