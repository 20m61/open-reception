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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();


/** `npm run lint` の実体。`noUncheckedIndexedAccess` があるので undefined を畳んでおく。 */
function lintScript(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string | undefined>;
  };
  return pkg.scripts?.lint ?? '';
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
   * 🔴 **抑止の棚卸しは自前で数えない。** ここは 4 周にわたって「綴りを自前で探す」実装を
   * 直し続け、そのたびに独立レビューが別の書き方で素通りさせた（固定文字列 → 正規表現 →
   * コメントの文法判定。最後は理由の区切りが 2 個以上のハイフンであること、文字列リテラル中の
   * ブロックコメント開始記号が抽出を壊すことで破られた）。**ESLint の文法を手写しすること
   * 自体が前提の誤り**だったので、`--no-inline-config` の差分を ESLint に出させる形へ移した。
   *
   * ここではその棚卸しが**ゲートで実際に走ること**だけを固定する
   * （「存在するが実行されない guard」を作らないため）。
   */
  it('抑止の棚卸しが npm script として存在する', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string | undefined>;
    };
    expect(pkg.scripts?.['lint:suppressions']).toBe('node scripts/check-lint-suppressions.mjs');
  });

  it('抑止の棚卸しが品質ゲート（fast 以外）で呼ばれている', () => {
    const gate = readFileSync(join(ROOT, 'scripts/quality-gate.sh'), 'utf8');
    expect(gate, 'ゲートから呼ばれない guard は「存在するが実行されない」形になる').toContain(
      'npm run --silent lint:suppressions',
    );
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
  it('KioskFlow の受付作成 effect が snapshotForCall を依存に持つ（結合の片側だけ縛らない）', () => {
    const src = readFileSync(join(ROOT, 'src/components/kiosk/KioskFlow.tsx'), 'utf8');
    expect(
      src,
      '受付作成 effect の依存から snapshotForCall が消えた。不変性 pin だけでは結合を守れない',
    ).toMatch(/\}, \[data\.state,[^\]]*snapshotForCall[^\]]*\]\);/);
  });

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
