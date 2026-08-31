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
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();


/**
 * 🔴 **綴りを列挙しない。** ここは 3 周にわたって「見落とした綴りを足す」修正を繰り返し、
 * そのたびに独立レビューが別の綴りで素通りさせた（1 綴り → 3 綴り → さらに 3 通り）。
 * 前提そのものが 2 つ間違っていた:
 *
 *  1. **ルール名は省略できる。** 省略した `eslint-disable` は**全ルールを外す**ので、
 *     名前を書くより強い。「ルール名を含む行」を探す網には最強の形が引っかからない
 *  2. **ディレクティブは 1 物理行に収まらない。** ブロックコメントは改行を跨げるので、
 *     行単位に `split` してから探す方式では原理的に見えない
 *
 * そこで**コメントを取り出し、その本文がディレクティブかどうかを文法で判定する**。
 * これなら「思いついた綴り」に依存せず、検査したと言い切れる。
 * （`.claude/rules/opus5-autonomous-loop.md`「値の調整を繰り返すのをやめ、前提を疑う」）
 */

/** 行コメントとブロックコメントの両方。ブロックは改行を跨ぐ。 */
const COMMENT_RE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
/** コメント本文の先頭がディレクティブか。捕獲するのは「ルール列 + 理由」。 */
const DIRECTIVE_RE = /^eslint-disable(?:-next-line|-line)?\b([\s\S]*)$/;
const TARGET_RULE = 'react-hooks/exhaustive-deps';

type Directive = { file: string; line: number; rules: string; reason: string };

/** コメントの囲みを外して本文だけにする。ブロック内の行頭 `*` も落とす。 */
function commentBody(raw: string): string {
  const inner = raw.startsWith('//')
    ? raw.slice(2)
    : raw.slice(2, -2).replace(/^[ \t]*\*/gm, '');
  return inner.trim();
}

/** lint 対象と揃える。`walk` の拡張子フィルタでは `.mjs` を取りこぼしていた。 */
function lintedFiles(): string[] {
  return execFileSync('git', ['ls-files', 'src', 'tests', 'scripts', 'eslint-rules', '*.ts', '*.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => /\.(tsx?|mjs)$/.test(f));
}

/** ファイル中の eslint-disable 系ディレクティブを全部拾う（綴りに依存しない）。 */
function directives(): Directive[] {
  const out: Directive[] = [];
  for (const file of lintedFiles()) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    for (const m of src.matchAll(COMMENT_RE)) {
      const d = DIRECTIVE_RE.exec(commentBody(m[0]));
      if (!d) continue;
      // `--` 以降は理由。手前がルール列（空なら無差別）。
      const [rulesPart = '', ...reasonParts] = (d[1] ?? '').split(/\s--\s/);
      out.push({
        file,
        line: src.slice(0, m.index).split('\n').length,
        rules: rulesPart.trim(),
        reason: reasonParts.join(' -- ').trim(),
      });
    }
  }
  return out;
}

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
   * 🔴 **抑止は ratchet からも error からも見えない。** 場所と理由を固定して、
   * 「error にしたのに 1 行 disable で戻す」経路を可視化する。
   * guard の目的は**禁止ではなく、レビューに晒すこと**である。理由を書けば抑止は通る。
   */
  it('exhaustive-deps の抑止は既知の 3 箇所だけ', () => {
    const found = directives().filter((d) => d.rules.includes(TARGET_RULE));
    expect([...new Set(found.map((d) => d.file))].sort()).toEqual([
      'src/components/kiosk/KioskFlow.tsx',
      'src/components/kiosk/checkout/CheckoutFlow.tsx',
      'src/components/kiosk/reception-screens.tsx',
    ]);
    // 件数も見る（同一ファイル内で 2 件目に増える形を止める）。
    expect(
      found.length,
      `抑止が増えている:\n${found.map((d) => `  ${d.file}:${d.line}`).join('\n')}`,
    ).toBe(3);
  });

  it('抑止には必ず `--` の理由が書かれている', () => {
    for (const d of directives().filter((x) => x.rules.includes(TARGET_RULE))) {
      expect(
        d.reason,
        `${d.file}:${d.line} に理由が無い。理由の無い抑止は warn に戻したのと同じ`,
      ).not.toBe('');
    }
  });

  /**
   * ルール名を書かない `eslint-disable` は**そのファイル（または次の行）の全ルールを外す**。
   * 名前を書くより強く、上の「理由を書く」規約もすり抜けるので 0 件で固定する。
   * 行コメント・ブロックコメント・複数行ブロックのいずれの綴りでも捕まる。
   */
  it('ルール名を書かない無差別 eslint-disable は存在しない', () => {
    const blanket = directives().filter((d) => d.rules === '');
    expect(
      blanket.map((d) => `${d.file}:${d.line}`),
      '無差別抑止は全ルールを外す。ルール名を明記すること',
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
