import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { font } from '@/components/admin/ui/tokens';

/**
 * 管理画面の文字サイズをトークンへ寄せる (#915 / 課題 28)。
 *
 * 監査は「最頻の 3 つ（0.85 / 0.8 / 0.9rem）はスケールのどれにも無い」と書いていたが、
 * 🔴 **`0.85rem` は `font.small` そのもの**だった。同様に `0.95` / `0.75` / `1.1` も
 * スケール上に居る。つまり 54 件は**トークンがあるのに使っていないだけ**で、
 * 置き換えても 1 ピクセルも動かない。それを片付けたうえで、**残りを数える**。
 *
 * 残りは「スケールに無い値」で、寄せると文字サイズが動く（＝VRT が動く）。
 * どこにいくつ残っているかが分からないと方針を決められないので、ここで台帳にする。
 */

const DIRS = ['src/components/admin', 'src/app/admin'];

function adminSources(dir: string): string[] {
  return readdirSync(join(process.cwd(), dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return adminSources(rel);
    return e.isFile() && e.name.endsWith('.tsx') && !e.name.includes('.test.') ? [rel] : [];
  });
}

function literals(): { value: string; file: string }[] {
  return DIRS.flatMap(adminSources).flatMap((rel) =>
    [...readFileSync(join(process.cwd(), rel), 'utf8').matchAll(/fontSize: '([0-9.]+rem)'/g)].map(
      (m) => ({ value: String(m[1]), file: rel }),
    ),
  );
}

/** スケール上の値（リテラルで書く理由が無い）。 */
const ON_SCALE = new Set<string>(Object.values(font));

/**
 * スケールに無い値の残数。**上限**として使う（減るのは歓迎、増えるのは退行）。
 * 寄せると文字サイズが動くので、方針が決まるまではここで数を止める。
 */
const REMAINING_BUDGET: Readonly<Record<string, number>> = {
  '0.8rem': 30,
  '0.9rem': 26,
  '1rem': 20,
  '1.05rem': 11,
  '0.875rem': 4,
  '0.8125rem': 4,
  '0.78rem': 4,
  '0.72rem': 1,
  '0.82rem': 1,
  '0.84rem': 1,
};

describe('文字サイズのトークン採用 (#915 / 課題 28)', () => {
  it('スケール上の値をリテラルで書かない', () => {
    /*
     * 置き換えても描画が変わらないので、ここに残す理由が無い。
     * 一度片付けたら、戻ってこないようにする。
     */
    const offenders = literals()
      .filter((l) => ON_SCALE.has(l.value))
      .map((l) => `${relative('src', l.file)}: ${l.value}`);
    expect(offenders).toEqual([]);
  });

  it('スケールに無い値は台帳の数を超えない', () => {
    const counts: Record<string, number> = {};
    for (const l of literals()) {
      if (ON_SCALE.has(l.value)) continue;
      counts[l.value] = (counts[l.value] ?? 0) + 1;
    }
    // 新しい値を持ち込まない（20 種に散っていたのがこの項目の出発点）。
    expect(Object.keys(counts).filter((v) => !(v in REMAINING_BUDGET))).toEqual([]);
    for (const [value, n] of Object.entries(counts)) {
      expect(n, `${value} が台帳より増えている`).toBeLessThanOrEqual(REMAINING_BUDGET[value] ?? 0);
    }
  });

  /*
   * 下界。上の 2 本は「admin から fontSize を全部消す」で通る。
   * トークンが実際に使われていることを縛る。
   */
  it('下界: font トークンが実際に使われている', () => {
    const uses = DIRS.flatMap(adminSources)
      .map((rel) => readFileSync(join(process.cwd(), rel), 'utf8'))
      .reduce((n, s) => n + [...s.matchAll(/fontSize: font\.[a-z]+/g)].length, 0);
    expect(uses).toBeGreaterThanOrEqual(50);
  });
});
