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

/**
 * 🔴 **抑止の綴りは 1 つではない。** 固定文字列 `eslint-disable-next-line …` だけを見ていた
 * 版は、独立レビューの実測で **2 通りの完全バイパス**を通した:
 *
 *  - `// eslint-disable-line react-hooks/exhaustive-deps`（行末形・理由なし）
 *  - `/* eslint-disable react-hooks/exhaustive-deps *\/`（ブロック形。**1 行でファイルまるごと**除外）
 *
 * どちらも `eslint --max-warnings 74` は EXIT=0、旧テストも 6 passed だった。
 * `CLAUDE.md`「調査の作法」が名指ししている「固定文字列で探すと変種を取りこぼす」型そのもの。
 */
const SUPPRESSION_RE =
  /eslint-disable(?:-next-line|-line)?\b[^\n]*\breact-hooks\/exhaustive-deps\b/;
/** ルール名を書かない無差別抑止。1 行でそのファイルの全ルールが外れる。 */
const BLANKET_RE = /\/\*\s*eslint-disable\s*\*\//;
/** 同じ行に `-- 理由` があること。多ルール列挙・順序入替えも許容する。 */
const REASON_RE = /react-hooks\/exhaustive-deps\b[^\n]*?\s--\s+\S/;

/**
 * 走査対象。`eslint .` の対象と揃える（`src` だけだと `tests/config` などへ逃がせる）。
 * **本ファイル自身は除く** —— 上の doc とパターン定義が自分にマッチしてしまうため。
 */
const SCAN_DIRS = ['src', 'tests'];
const SELF = 'tests/config/lint-warning-budget.test.ts';

/** `npm run lint` の実体。`noUncheckedIndexedAccess` があるので undefined を畳んでおく。 */
function lintScript(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string | undefined>;
  };
  return pkg.scripts?.lint ?? '';
}

type Hit = { file: string; line: number; text: string };

function scan(match: RegExp): Hit[] {
  return SCAN_DIRS.flatMap((dir) => walk(join(ROOT, dir))).flatMap((file) => {
    const rel = file.slice(ROOT.length + 1);
    if (rel === SELF) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .map((text, i) => ({ file: rel, line: i + 1, text }))
      .filter(({ text }) => match.test(text));
  });
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
   * 🔴 **抑止は ratchet からも error からも見えない。** 件数と場所を固定して、
   * 「error にしたのに 1 行 disable で戻す」経路を可視化する。増やすときは
   * このテストを直すことになり、レビューに必ず目が入る。
   *
   * guard の目的は**禁止ではなく、レビューに晒すこと**である。理由を書けば抑止は通る。
   */
  it('exhaustive-deps の抑止は既知の 3 箇所だけ（綴りの違いも拾う）', () => {
    const found = scan(SUPPRESSION_RE);
    // 件数だけだと「1 件消して別の効果へ 1 件足す」交換が素通りするので**場所**で縛る。
    expect([...new Set(found.map((f) => f.file))].sort()).toEqual([
      'src/components/kiosk/KioskFlow.tsx',
      'src/components/kiosk/checkout/CheckoutFlow.tsx',
      'src/components/kiosk/reception-screens.tsx',
    ]);
    expect(
      found.length,
      `抑止が増えている:\n${found.map((f) => `  ${f.file}:${f.line}`).join('\n')}`,
    ).toBeLessThanOrEqual(3);
  });

  it('抑止には必ず同じ行に `--` の理由が書かれている', () => {
    for (const { file, line, text } of scan(SUPPRESSION_RE)) {
      expect(
        REASON_RE.test(text),
        `${file}:${line} に理由が無い。理由の無い抑止は warn に戻したのと同じ`,
      ).toBe(true);
    }
  });

  /**
   * ルール名を書かない `/* eslint-disable *\/` は、**1 行でそのファイルの全ルールを外す**。
   * 抑止としては最も強く、上の「理由を書く」規約もすり抜けるので 0 件で固定する。
   */
  it('ルール名を書かない無差別 eslint-disable は存在しない', () => {
    const found = scan(BLANKET_RE);
    expect(
      found.map((f) => `${f.file}:${f.line}`),
      '無差別抑止はファイルごと検査対象から外す。ルール名を明記すること',
    ).toEqual([]);
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
    ).toMatch(/\}, \[data\.state,[^\]]*snapshotForCall\]\);/);
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
