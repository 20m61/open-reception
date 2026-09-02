import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { radius, space, motion, zIndex } from '@/components/admin/ui/tokens';

/**
 * カタログの散文が実測から遅れないようにする (#903 / 課題 27)。
 *
 * `docs/component-catalog.md` は **`radius` を `#329` 以前の値**（sm:8 / md:12 / lg:16 /
 * pill:999）で教え続けていた。実際は sm:10 / md:14 / lg:18 / xl:28 / pill:9999 へ是正され
 * parity テストで固定済みで、`xl` の存在すら書かれていなかった。
 *
 * 🔴 **これは「文書の訂正がそのまま実質的な修正になる」型である。** 新しい画面を書く人は
 * カタログを読むので、間違った値が書いてあると**そのとおりに実装される**。
 * 一度直すだけでは同じことが起きるので、ここで機械に読ませる
 * （`tests/config/loop-round-skill.test.ts` が委譲プロンプト生成器に対してやっているのと同じ形）。
 */

const CATALOG = readFileSync(join(process.cwd(), 'docs/component-catalog.md'), 'utf8');

/** `- \`name\` … a:1 / b:2 …` の行から `名前:値` の対を読む。 */
function tokenLine(name: string): string {
  const line = CATALOG.split('\n').find((l) => l.startsWith(`- \`${name}\` …`));
  expect(line, `カタログに \`${name}\` の行が無い`).toBeTruthy();
  return String(line);
}

function statedValues(name: string): Record<string, string> {
  const entries = [...tokenLine(name).matchAll(/([A-Za-z]+):(\d+)/g)];
  return Object.fromEntries(entries.map((m) => [String(m[1]), String(m[2])]));
}

/**
 * 値を持たず名前だけ並ぶ行（`motion` / `font` 等）から名前を読む。
 *
 * カタログは名前をバッククォート無しで並べる（`font` / `color` の行と同じ書き方）ので、
 * 見出しの `\`name\`` を落としたうえで英単語を拾う。
 */
function statedNames(name: string): string[] {
  const body = tokenLine(name).replace(/^- `[A-Za-z]+` …/, '');
  return [...body.matchAll(/[A-Za-z]+/g)].map((m) => String(m[0]));
}

describe('カタログとトークンの一致 (#903 / 課題 27)', () => {
  it.each([
    ['radius', radius],
    ['space', space],
  ] as const)('%s の値がカタログと一致する', (name, actual) => {
    const stated = statedValues(name);
    // 上界: 書いてある値が実装と合っている。
    for (const [key, value] of Object.entries(stated)) {
      expect(Number(value), `${name}.${key} がカタログとずれている`).toBe(
        (actual as Record<string, number>)[key],
      );
    }
    // 下界: 実装にあるキーが**全部**書かれている（`xl` の書き漏れがまさにこれだった）。
    expect(Object.keys(stated).sort()).toEqual(Object.keys(actual).sort());
  });

  it.each([
    ['motion', motion],
    ['zIndex', zIndex],
  ] as const)('%s がカタログに載っている', (name, actual) => {
    /*
     * この 2 つは値ではなく**存在**を縛る。zIndex は 11 層あり全部を散文へ書くと
     * かえって古びるので、行があることと意味の在り処（テスト）が指されていることだけ見る。
     */
    expect(tokenLine(name).length).toBeGreaterThan(0);
    expect(Object.keys(actual).length).toBeGreaterThan(0);
  });

  it('motion の 5 つの名前がカタログに書かれている', () => {
    const stated = statedNames('motion');
    // 下界: 名前を 1 つでも落としたら落ちる。
    for (const key of ['fast', 'base', 'slow', 'spin', 'pulse']) {
      expect(stated, `motion.${key} がカタログに無い`).toContain(key);
    }
  });
});
