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
const RULE = 'react-hooks/exhaustive-deps';


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

  /**
   * 🔴 **文字列一致では実効 severity を保証できない。** flat config は**後勝ち**なので、
   * 後段に `{ files: [...], rules: { 'react-hooks/exhaustive-deps': 'off' } }` を足しても
   * 前段の `'error'` という文字列は残る。以前の版はそれを `toMatch` で見ていたため、
   * **「rule は error」と読めるのに実効は off** という状態を緑のまま通していた（実測）。
   *
   * さらに `--no-inline-config` の主検査（`scripts/check-lint-suppressions.mjs`）も、
   * 無効化するのは **inline 指示だけ**で config 側は生きたままなので、
   * **既知 3 ファイル以外へスコープした上書き・`ignores` 追加は期待値を 1 ミリも動かさない**。
   * config の形そのものをここで縛る（eslint を回さないので数百 ms）。
   */
  it('react-hooks/exhaustive-deps を設定するエントリが 2 つで、実効（後勝ち）が error', async () => {
    const cfg = (await import('../../eslint.config.mjs')).default as {
      rules?: Record<string, unknown>;
      ignores?: string[];
    }[];
    const setters = cfg.filter((c) => c.rules?.[RULE] !== undefined);
    expect(
      setters.map((c) => c.rules?.[RULE]),
      'setter が増減した。後段の上書きで実効 severity が変わっていないか',
    ).toEqual(['warn', 'error']);
  });

  /**
   * `ignores` に 1 行足すだけで、そのファイルは lint 対象から外れる。棚卸しにも予算にも
   * 現れないので、ここで固定する。増やすときはこのテストを直す＝レビューに目が入る。
   */
  it('eslint.config.mjs の ignores が期待どおり', async () => {
    const cfg = (await import('../../eslint.config.mjs')).default as { ignores?: string[] }[];
    expect(cfg.flatMap((c) => c.ignores ?? [])).toEqual([
      'node_modules/**',
      '.next/**',
      '.open-next/**',
      'infra/**',
      'tests/e2e/**',
      'playwright-report/**',
      'coverage/**',
      'test-results/**',
      '.claude/worktrees/**',
      '.next/**',
      'out/**',
      'build/**',
      'next-env.d.ts',
      '.next/**',
      'out/**',
      'build/**',
      'next-env.d.ts',
      'src/components/**/*.test.ts',
      'src/components/**/*.test.tsx',
    ]);
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
