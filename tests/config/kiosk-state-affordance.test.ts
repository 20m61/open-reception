import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 「押せない」を透明度だけで表さないことを機械で縛る (#778 AC3)。
 *
 * 受付端末は明るいロビーに置かれ、来訪者は初見で使う。`opacity` を下げただけの
 * ボタンは「押せない」ではなく「ただのボタン」に見え、反応しないまま連打される。
 * 高コントラストモードではさらに悪く、透明度は**意味を伝えずコントラストだけを削る**。
 *
 * 規約を散文で書いても戻る（#776 の相手選択カードは `opacity: 0.55` だけで不在を
 * 表しており、レビューで指摘されるまで残っていた）。CSS を読んで落とす。
 */
/**
 * 走査対象は `src/**` の CSS **すべて**。`globals.css` だけを読むと、CSS Modules を
 * 新規追加した増分で同じ穴がまた開く（実際に `KioskChatDrawer.module.css` の
 * `.send:disabled` が opacity だけのまま残っていた）。
 */
function allCssFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) found.push(...allCssFiles(full));
    else if (entry.name.endsWith('.css')) found.push(full);
  }
  return found;
}

const SRC = resolve(__dirname, '../../src');
const CSS_FILES = allCssFiles(SRC).map((path) => ({
  path: path.slice(SRC.length + 1),
  css: readFileSync(path, 'utf-8'),
}));

/** セレクタと宣言ブロックの組を素朴に取り出す（@media 等のネストは対象外で十分）。 */
function ruleBlocks(css: string): ReadonlyArray<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = [];
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(withoutComments)) !== null) {
    const selector = m[1]!.trim();
    if (selector.startsWith('@')) continue;
    rules.push({ selector, body: m[2]! });
  }
  return rules;
}

/** 「押せない／利用できない」状態を対象にしたセレクタか。 */
function targetsUnavailableState(selector: string): boolean {
  return (
    /:disabled(?!\))/.test(selector) ||
    selector.includes('[aria-disabled') ||
    selector.includes('[data-unavailable') ||
    selector.includes('--unavailable')
  );
}

/**
 * 「処理中」になり得る状態を狙ったセレクタか。`[data-unavailable]`（担当者の不在）は
 * 往復を伴わないので対象外。`:hover:not(:disabled)` のような否定形も除く。
 */
function targetsDisabledState(selector: string): boolean {
  return /:disabled(?!\))/.test(selector);
}

/** 透明度以外に、状態を伝える視覚的な宣言を持つか。 */
const MEANING_BEARING = [
  'background',
  'border',
  'color',
  'outline',
  'text-decoration',
  'content',
  'box-shadow',
];

describe('kiosk: 押せない状態を透明度だけで表さない (#778 AC3)', () => {
  const stateRules = CSS_FILES.flatMap(({ path, css }) =>
    ruleBlocks(css)
      .filter((r) => targetsUnavailableState(r.selector))
      .map((r) => ({ ...r, path })),
  );

  it('対象のルールが実在する（セレクタの書き方が変わって空振りしていない）', () => {
    // 0 件なら「全部通った」ではなく「何も見ていない」。
    expect(CSS_FILES.length).toBeGreaterThan(0);
    expect(stateRules.length).toBeGreaterThan(0);
    expect(stateRules.some((r) => /\.btn:disabled/.test(r.selector))).toBe(true);
  });

  it('どのルールも opacity と cursor だけで状態を表現していない', () => {
    for (const rule of stateRules) {
      const declares = (prop: string) =>
        new RegExp(`(?:^|;)\\s*${prop}[a-z-]*\\s*:`, 'm').test(rule.body);
      if (!declares('opacity')) continue;
      const meaning = MEANING_BEARING.filter(declares);
      expect(
        meaning,
        `${rule.path} のセレクタ "${rule.selector}" は opacity 以外に状態を伝える宣言を持たない`,
      ).not.toEqual([]);
    }
  });

  it('`.btn:disabled` は面・枠の形・文字色で「押せない」を示す', () => {
    // 「処理中」用の除外ルールではなく、**無効表現を持つ側**を選ぶ。
    const btn = stateRules.find(
      (r) => /\.btn:disabled/.test(r.selector) && /border-style/.test(r.body),
    );
    expect(btn).toBeDefined();
    const body = btn!.body;
    expect(body, 'background を指定していない').toMatch(/background/);
    expect(body, 'color を指定していない').toMatch(/(?:^|;)\s*color\s*:/m);
    // 🔴 `border` だけを見ると `border-color` 単独で満たせてしまい、`.btn--secondary` と
    // 画素レベルで同一の treatment が通る。**形（破線）**が規約の本体なので名指しで縛る。
    expect(body, 'border-style: dashed を指定していない').toMatch(/border-style\s*:\s*dashed/);
  });
});

describe('kiosk: 「処理中」を「押せない」と同じ見た目にしない (#792)', () => {
  /*
   * 対象は `:disabled` を狙う**すべての**ルール。`.btn` だけに絞ると、CSS Modules
   * （`.send:disabled` 等）に同じ穴が残る。`[data-unavailable]` 系は「処理中」になり得ない
   * 状態（担当者の不在）なので対象外でよい。
   */
  const btnRules = CSS_FILES.flatMap(({ path, css }) =>
    ruleBlocks(css)
      .filter((r) => targetsDisabledState(r.selector))
      .map((r) => ({ ...r, path })),
  );

  it('無効表現を持つルールは `aria-busy` を除外している', () => {
    // 除外が無いと、送信の往復の間だけ主 CTA が破線へ落ち、来訪者は
    // 「押せなくなった」と読む（#778 AC3 を満たすほど悪化する、という矛盾）。
    const treatments = btnRules.filter((r) => /border-style|background\s*:/.test(r.body));
    expect(treatments.length, '無効表現を持つルールが見つからない').toBeGreaterThan(0);
    // 母集団が 1 ファイルへ狭まっていないこと。`.btn` だけに絞ると CSS Modules に
    // 同じ穴が残る（実際 `.send:disabled` がそうだった）。
    expect(new Set(treatments.map((r) => r.path)).size).toBeGreaterThan(1);
    for (const rule of treatments) {
      // 🔴 `='true'` まで縛る。`:not([aria-busy])` だと React が常に出す
      // `aria-busy="false"` にもマッチし、**条件未達の表現が恒久的に消える**。
      expect(
        rule.selector,
        `${rule.path} の "${rule.selector}" が aria-busy='true' を除外していない`,
      ).toMatch(/:not\(\[aria-busy\s*=\s*['"]true['"]\]\)/);
    }
  });
});
