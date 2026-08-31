/**
 * lint の warning 予算と、その**抜け道**を機械で縛る (#813)。
 *
 * #813 は「warning がゲートを素通りする」穴を塞いだが、散文だけの規約は守られない
 * （`docs/quality-gate.md` 自身が「CI が無い以上、規約だけでは守られない」と書いている）。
 * 独立レビューで実測されたとおり、error 化した `react-hooks/exhaustive-deps` は
 * **理由の無い 1 行 `eslint-disable-next-line` でゼロコストに無効化でき**、
 * 使用済みディレクティブは warning を 1 件も増やさないので ratchet にも掛からない。
 * ここで抑止の件数と理由を固定して、穴が同じ場所へ戻らないようにする。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const SUPPRESSION = 'eslint-disable-next-line react-hooks/exhaustive-deps';

/** `npm run lint` の実体。`noUncheckedIndexedAccess` があるので undefined を畳んでおく。 */
function lintScript(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string | undefined>;
  };
  return pkg.scripts?.lint ?? '';
}

function suppressions(): { file: string; line: number; text: string }[] {
  return walk(join(ROOT, 'src')).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .map((text, i) => ({ file: file.slice(ROOT.length + 1), line: i + 1, text }))
      .filter(({ text }) => text.includes(SUPPRESSION)),
  );
}

describe('lint の warning 予算 (#813)', () => {
  it('npm run lint は --max-warnings を持つ（無いと warning が素通りする）', () => {
    expect(lintScript()).toMatch(/--max-warnings\s+\d+/);
  });

  it('予算の数値が docs/quality-gate.md の記載と一致する（散文が実測から遅れない）', () => {
    const budget = /--max-warnings\s+(\d+)/.exec(lintScript())?.[1];
    expect(budget).toBeDefined();
    const docs = readFileSync(join(ROOT, 'docs/quality-gate.md'), 'utf8');
    expect(docs, `docs に --max-warnings ${budget} の記載が無い`).toContain(
      `--max-warnings ${budget}`,
    );
  });

  it('react-hooks/exhaustive-deps は error（warn だと依存の取りこぼしが素通りする）', () => {
    const config = readFileSync(join(ROOT, 'eslint.config.mjs'), 'utf8');
    expect(config).toMatch(/'react-hooks\/exhaustive-deps':\s*'error'/);
  });

  /**
   * 🔴 **抑止は ratchet からも error からも見えない。** 件数を固定して、
   * 「error にしたのに 1 行 disable で戻す」経路を可視化する。増やすときは
   * このテストを直すことになり、レビューで必ず目に入る。
   */
  it('exhaustive-deps の抑止は 3 件以下（増やすなら理由をレビューに晒す）', () => {
    const found = suppressions();
    expect(
      found.length,
      `抑止が増えている:\n${found.map((f) => `  ${f.file}:${f.line}`).join('\n')}`,
    ).toBeLessThanOrEqual(3);
  });

  it('抑止には必ず同じ行に `--` の理由が書かれている', () => {
    for (const { file, line, text } of suppressions()) {
      expect(
        text,
        `${file}:${line} に理由が無い。理由の無い抑止は warn に戻したのと同じ`,
      ).toMatch(/exhaustive-deps\s+--\s+\S/);
    }
  });
});

/**
 * `KioskFlow` の受付作成 effect は `snapshotForCall` を依存に持つ (#813)。これは
 * `useCallback(..., [])` で **identity が不変**だから安全なのであって、依存が 1 つでも
 * 増えると **`calling` の最中に effect が再実行され、受付レコードと担当者呼び出しが
 * 二重に発生する**（cleanup が `cancelled` を立てるので画面には痕跡が残らない）。
 * `exhaustive-deps` は「依存は書いてある」ので何も言わない。ここで不変性そのものを縛る。
 */
describe('snapshotForCall の identity 不変性 (#813)', () => {
  it('useExperienceMetrics の snapshotForCall は依存空の useCallback である', () => {
    const src = readFileSync(join(ROOT, 'src/components/kiosk/useExperienceMetrics.ts'), 'utf8');
    const m = /const snapshotForCall = useCallback\(([\s\S]*?)\n  \);/.exec(src);
    expect(m, 'snapshotForCall の useCallback が見つからない（実装が変わった）').not.toBeNull();
    expect(
      /\[\s*\]\s*,?\s*$/.test(m?.[1] ?? ''),
      'snapshotForCall の依存が空でなくなった。KioskFlow の受付作成 effect が calling 中に ' +
        '再実行され、受付と呼び出しが二重に発生する。依存を増やすなら KioskFlow 側を ref 経由へ変えること',
    ).toBe(true);
  });
});
