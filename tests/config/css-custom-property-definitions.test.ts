import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';

/**
 * CSS カスタムプロパティの「宣言されていない参照」と「派生トークンの取りこぼし」を
 * 機械で落とす (#869)。
 *
 * ## なぜ 2 つを 1 つのテストに入れるか
 *
 * どちらも「トークンが存在するか」ではなく **「トークンが効いているか」** の検査で、
 * 既存の `tokens-css-parity.test.ts`（CSS と TS の値の一致）では原理的に見えない。
 *
 * 1. **未定義の参照** … `var(--x)` にフォールバックが無く `--x` の宣言もどこにも無いと、
 *    宣言全体が invalid at computed-value time になって**継承へ落ちる**。エラーは出ず、
 *    その要素だけ静かに親のサイズを引き継ぐ。
 *    `globals.css` は同じ穴を `--font-sm` で一度踏んで注記まで残していたのに、
 *    `--font-md`（`.kiosk-quick-actions__more`）で**二度目**を踏んでいた。
 *
 * 2. **派生トークンの取りこぼし** … これが #869 の本体。`:root` の
 *    `--font-body: calc(1.25rem * var(--a11y-font-scale))` は、CSS の規則により
 *    **宣言された要素の計算値時点で置換される**。つまり `:root` での計算値が
 *    `calc(1.25rem * 1)` に固定され、そのまま子孫へ継承される。子孫で
 *    `--a11y-font-scale` だけを上書きしても、**置換済みの派生トークンは再計算されない**。
 *
 *    実測（1.6× 指定時）: `.screen__title` 54.924px / `.screen__lead` 33.432px /
 *    `.btn` 35px —— いずれも 1× と 1 ピクセルも変わらなかった。
 *    「大きな文字」支援モードは、属性は付くが**何も拡大していなかった**。
 *
 * ## 「3 つの名前」ではなく不変条件で縛る
 *
 * `--font-body` / `--font-lg` / `--font-xl` を名指しで検査すると、4 つ目の派生トークンが
 * 増えた瞬間に同じ穴が開く。**「あるトークンを上書きする場所では、そのトークンから
 * 導出される全トークンも併せて上書きする」**という不変条件で縛る。
 *
 * e2e（`kiosk-a11y-modes.spec.ts`）は計算値で同じことを実測するが、あちらは `--full`
 * でしか回らない。ここは `--fast` に入るので、内側ループで壊れたら即わかる。
 */

/** 走査対象は `src/**` の CSS と、インラインスタイルを書く TSX/TS すべて。 */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full));
      continue;
    }
    if (/\.(css|tsx|ts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

const SRC = resolve(process.cwd(), 'src');
const FILES = sourceFiles(SRC);

/**
 * コメントを外してから走査する。
 *
 * これを飛ばすと **注記の中の変数名を実コードだと誤認する**。実際、最初にこのテストを
 * 書いたときは `globals.css:1491` の「`var(--font-sm)` のような未定義トークンを書くと…」
 * という**警告文そのもの**を違反として報告していた。
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

/**
 * CSS には宣言が無いが、実行時に外から供給されると分かっている変数。
 *
 * **理由を書かずに足さないこと。** 「フォールバックを付けるのが面倒だから」で増やすと、
 * この検査は素通りする飾りになる。
 */
const RUNTIME_DEFINED: Readonly<Record<string, string>> = {
  // `next/font` の `Inter({ variable: '--font-inter' })` が <html> の className 経由で
  // 供給する（src/app/layout.tsx）。CSS 側に宣言は存在しない。
  '--font-inter': 'next/font が className 経由で供給する（src/app/layout.tsx）',
};

/** `--name:` の形で宣言されているカスタムプロパティ名（CSS でも TSX の style オブジェクトでも拾う）。 */
function declaredNames(text: string): string[] {
  return [...text.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]!);
}

/**
 * `var(--name)` の参照のうち**フォールバックが無いもの**。
 *
 * フォールバック付き（`var(--x, 96px)`）は「JS が設定するかもしれない」ことを明示した
 * 意図的な形なので対象外にする。実際 `--kiosk-voice-safe-bottom` /
 * `--kiosk-chat-safe-bottom` / `--kiosk-avatar-visual-max` はいずれもこの形で、
 * CSS には宣言が無いが正しく動く。
 */
function referencedWithoutFallback(text: string): string[] {
  return [...text.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g)].map((m) => m[1]!);
}

describe('CSS カスタムプロパティ: 宣言の無い参照を残さない (#869)', () => {
  it('フォールバック無しで参照されている変数は、どこかで宣言されている', () => {
    const declared = new Set(
      FILES.flatMap((f) => declaredNames(stripComments(readFileSync(f, 'utf8')))),
    );

    const dangling: string[] = [];
    for (const file of FILES) {
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const name of new Set(referencedWithoutFallback(text))) {
        if (declared.has(name) || name in RUNTIME_DEFINED) continue;
        dangling.push(`${relative(process.cwd(), file)}: var(${name})`);
      }
    }

    expect(
      dangling,
      '宣言の無いカスタムプロパティを参照している。invalid at computed-value time で\n' +
        '宣言全体が捨てられ、その要素は静かに継承値へ落ちる（エラーは出ない）。\n' +
        '定義を足すか、既存トークンへ寄せるか、意図的なら `var(--x, フォールバック)` にする。\n' +
        dangling.join('\n'),
    ).toEqual([]);
  });
});

describe('CSS カスタムプロパティ: 派生トークンは上書き元と同じ場所で再宣言する (#869)', () => {
  const GLOBALS = stripComments(readFileSync(resolve(SRC, 'app/globals.css'), 'utf8'));

  /** `--a11y-font-scale` のように、他のトークンの計算に使われる「元」のトークン。 */
  const SCALE_TOKEN = '--a11y-font-scale';

  /** セレクタブロックを雑に切り出す（`セレクタ { 中身 }`）。ネストは使っていない。 */
  function blocks(css: string): { selector: string; body: string }[] {
    return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
      selector: m[1]!.trim(),
      body: m[2]!,
    }));
  }

  it(`${SCALE_TOKEN} を上書きする場所では、そこから導出される全トークンも再宣言する`, () => {
    const all = blocks(GLOBALS);

    // `:root` 等で `var(--a11y-font-scale)` を使って定義されている派生トークン。
    const derived = new Set<string>();
    for (const { body } of all) {
      for (const m of body.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
        if (m[2]!.includes(`var(${SCALE_TOKEN})`)) derived.add(m[1]!);
      }
    }

    // 派生トークンが 1 つも見つからないなら、この検査自体が空虚に通っている。
    expect(derived.size, `${SCALE_TOKEN} から導出されるトークンが見つからない`).toBeGreaterThan(0);

    /*
     * `--a11y-font-scale` に**具体的な数値**を置いている全ブロック。定義元の `:root` も含める。
     *
     * 当初はここで `:root` を除外していたが、除外条件を「`var(--a11y-font-scale)` を含まない
     * ブロック」と書いたため、**修正して派生トークンを宣言した瞬間に対象が 0 件になり、
     * 検査が空虚に通る**ようになった（下の下界アサーションが検出した）。
     * 除外をやめて「倍率を置く場所は派生も置く」を全ブロックへ一様に課すほうが強い。
     */
    const overrides = all.filter(({ body }) =>
      new RegExp(`${SCALE_TOKEN}\\s*:\\s*[0-9.]`).test(body),
    );

    expect(overrides.length, `${SCALE_TOKEN} を上書きするブロックが見つからない`).toBeGreaterThan(1);

    const missing: string[] = [];
    for (const { selector, body } of overrides) {
      for (const token of derived) {
        if (!new RegExp(`${token}\\s*:`).test(body)) missing.push(`${selector} が ${token} を再宣言していない`);
      }
    }

    expect(
      missing,
      `${SCALE_TOKEN} を上書きしても、既に置換済みの派生トークンは再計算されない。\n` +
        '派生トークンを同じブロックで再宣言しないと、属性は付くのに寸法が 1 ピクセルも動かない。\n' +
        missing.join('\n'),
    ).toEqual([]);
  });
});

/**
 * **実行時にインラインで注入されるトークン**にも同じ不変条件を課す (#884)。
 *
 * ## なぜ上の検査では捕まらなかったか
 *
 * 上は「CSS のブロックが元トークンを上書きしている」場合しか見ない。ところが
 * `--brand-accent` は **`KioskFlow` が `main.screen` へインラインで注入する**ので、
 * CSS 側には上書きブロックが存在しない。よって上の検査は `--brand-accent` について
 * **構造的に何も言えなかった** —— #869 で正しい不変条件を書いたのに、対象が
 * `--a11y-font-scale` にべた書きされていたため、**同じ欠陥の 2 例目を見逃した**。
 *
 * ## 実測（修正前）
 *
 * `--brand-accent: #7f1d1d` を `.screen` へ注入したときの計算値:
 *
 * ```
 * --brand-accent   #38bdf8 → #7f1d1d   （注入は届いている）
 * --color-accent   #38bdf8 → #38bdf8   （追随しない）
 * 主 CTA の背景     バイト単位で同一
 * ```
 *
 * **テナントのブランド色は 1 度も効いたことが無かった。**
 *
 * ## 何を縛るか
 *
 * 「注入先のセレクタが、その元トークンから**推移的に**導出される全トークンを再宣言している」。
 * 推移閉包を取るのは、`--color-accent-soft` のように `--brand-accent` を直接は参照せず
 * `var(--color-accent)` 経由で derive されるものを取りこぼさないため。
 */
describe('CSS カスタムプロパティ: 実行時注入トークンの派生も注入先で再宣言する (#884)', () => {
  const GLOBALS = stripComments(readFileSync(resolve(SRC, 'app/globals.css'), 'utf8'));

  function blocks(css: string): { selector: string; body: string }[] {
    return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
      selector: m[1]!.trim(),
      body: m[2]!,
    }));
  }

  /**
   * 実行時にインラインで注入される元トークンと、その注入先セレクタ。
   *
   * 注入先は静的には決められない（React のインラインスタイル）ので、**人が読んで登録する**。
   * 登録が実態とずれたら e2e（`kiosk-brand-accent.spec.ts`）が落ちる —— 構造と挙動の両方で
   * 縛るのは、どちらか片方では「宣言はあるが効いていない」を見抜けないため。
   */
  const RUNTIME_INJECTED: readonly { token: string; injectedInto: string; source: string }[] = [
    { token: '--brand-accent', injectedInto: '.screen', source: 'components/kiosk/KioskFlow.tsx' },
  ];

  it.each(RUNTIME_INJECTED)(
    '$token の派生トークンは注入先 $injectedInto で再宣言されている',
    ({ token, injectedInto, source }) => {
      const all = blocks(GLOBALS);

      // 注入されていることを実ファイルで確かめる（登録が古くなったら落とす＝下界）。
      const injector = readFileSync(resolve(SRC, source), 'utf8');
      expect(injector, `${source} が ${token} を注入していない`).toContain(`'${token}'`);

      /*
       * 推移閉包。`--color-accent: var(--brand-accent)` だけでなく、
       * `--color-accent-soft: color-mix(... var(--color-accent) ...)` のように
       * 1 段以上離れて derive されるものまで集める。
       */
      const derived = new Set<string>();
      let grew = true;
      while (grew) {
        grew = false;
        for (const { body } of all) {
          for (const m of body.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
            const name = m[1]!;
            const value = m[2]!;
            if (derived.has(name)) continue;
            const dependsOnSource =
              value.includes(`var(${token})`) ||
              [...derived].some((d) => value.includes(`var(${d})`));
            if (dependsOnSource) {
              derived.add(name);
              grew = true;
            }
          }
        }
      }

      expect(derived.size, `${token} から導出されるトークンが見つからない`).toBeGreaterThan(1);

      const target = all.filter((b) => b.selector === injectedInto);
      expect(target.length, `注入先 ${injectedInto} のブロックが無い`).toBeGreaterThan(0);
      const targetBody = target.map((b) => b.body).join('\n');

      const missing = [...derived].filter((d) => !new RegExp(`${d}\\s*:`).test(targetBody));
      expect(
        missing,
        `${token} は ${injectedInto} へ実行時に注入されるが、そこで派生トークンが再宣言されて\n` +
          'いない。var() は宣言された要素の計算値時点で置換されるので、:root で確定した派生は\n' +
          '子孫で元トークンを差し替えても再計算されない（= 注入が一切効かない）。\n' +
          `再宣言されていない: ${missing.join(', ')}`,
      ).toEqual([]);
    },
  );
});
