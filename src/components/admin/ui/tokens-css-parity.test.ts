import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { color, radius, space } from './tokens';

/**
 * デザイントークン単一ソース化の検証 (issue #329)。
 *
 * `src/app/globals.css` の CSS 変数を **正（single source of truth）** とし、`tokens.ts` の
 * 同名トークンの実値が一致することを機械検証する。着手時点で radius / border が両者で
 * 乖離していた（radius TS 8/12/16 vs CSS 10/14/18、border TS rgba .1/.2 vs CSS .08/.16）ため、
 * 将来どちらか一方だけを触った際の再乖離をこのテストで検出する。
 */
const GLOBALS_CSS = fs.readFileSync(
  path.join(process.cwd(), 'src/app/globals.css'),
  'utf8',
);

/** globals.css の :root から `--name` の生値（`;` 手前まで）を取り出す。 */
function cssVar(name: string): string {
  const m = new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(GLOBALS_CSS);
  if (!m?.[1]) throw new Error(`globals.css に --${name} が見つからない`);
  return m[1].trim();
}

/** `10px` → 10。px 値の CSS 変数を数値化する。 */
function cssPx(name: string): number {
  const raw = cssVar(name);
  const m = /^(\d+(?:\.\d+)?)px$/.exec(raw);
  if (!m) throw new Error(`--${name} は px 値ではない: ${raw}`);
  return Number(m[1]);
}

describe('radius: tokens.ts と globals.css の一致 (#329)', () => {
  it('sm/md/lg/xl/pill が CSS の --radius-* と同値', () => {
    expect(radius.sm).toBe(cssPx('radius-sm'));
    expect(radius.md).toBe(cssPx('radius-md'));
    expect(radius.lg).toBe(cssPx('radius-lg'));
    expect(radius.xl).toBe(cssPx('radius-xl'));
    // --radius-pill は 9999px（旧 TS の 999 との乖離を解消済み）。
    expect(radius.pill).toBe(cssPx('radius-pill'));
  });

  it('CSS を正とした具体値（回帰時に気づけるよう固定）', () => {
    expect(radius).toEqual({ sm: 10, md: 14, lg: 18, xl: 28, pill: 9999 });
  });
});

describe('space: tokens.ts と globals.css の一致 (#329)', () => {
  it('sm/md/lg/xl が CSS の --space-* と同値', () => {
    expect(space.sm).toBe(cssPx('space-sm'));
    expect(space.md).toBe(cssPx('space-md'));
    expect(space.lg).toBe(cssPx('space-lg'));
    expect(space.xl).toBe(cssPx('space-xl'));
  });
});

describe('border: tokens.ts が CSS 変数を単一ソースとして参照 (#329)', () => {
  it('border / borderStrong は var(--color-border*) を参照し、CSS に定義がある', () => {
    expect(color.border).toBe('var(--color-border)');
    expect(color.borderStrong).toBe('var(--color-border-strong)');
    // 参照先が globals.css に実在する（rgba 半透明値）。
    expect(cssVar('color-border')).toMatch(/^rgba\(/);
    expect(cssVar('color-border-strong')).toMatch(/^rgba\(/);
  });
});

describe('color: 全トークンが CSS 変数参照で単一ソース化されている (#329)', () => {
  it('color.* はすべて var(--…) 参照で、参照先が globals.css に実在する', () => {
    for (const [key, value] of Object.entries(color)) {
      const m = /^var\((--[\w-]+)\)$/.exec(value);
      expect(m?.[1], `${key} は var(--…) 参照であるべき: ${value}`).toBeTruthy();
      const varName = m![1]!.slice(2); // 先頭 '--' を除去
      expect(
        new RegExp(`${varName}\\s*:`).test(GLOBALS_CSS),
        `--${varName} が globals.css に無い`,
      ).toBe(true);
    }
  });

  it('テナントテーマ: --color-accent は --brand-accent 由来（差し替えが波及する）', () => {
    expect(color.accent).toBe('var(--color-accent)');
    expect(cssVar('color-accent')).toBe('var(--brand-accent)');
  });
});
