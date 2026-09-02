import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 管理画面の**見出し構造**と**モーダルのフォーカス管理** (#890 / 課題 15・16)。
 *
 * 決定 D2 のとおり、admin は「標準的な支援技術で使えること」を担保する（キオスクのような
 * 支援モード UI は持たせない）。ここはそのうち構造で縛れる 2 つ。
 */
const ADMIN_PAGES = resolve(process.cwd(), 'src/app/admin');
const ADMIN_COMPONENTS = resolve(process.cwd(), 'src/components/admin');

function findFiles(dir: string, match: (name: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findFiles(path, match));
    else if (match(entry.name)) found.push(path);
  }
  return found;
}

/**
 * ページ根が最終的に `h1` を出すか。
 *
 * 🔴 **ファイル単位で数えない。** `<Section>` を使い `h1` を持たないファイルは 7 つあるが、
 * うち 3 つ（`ExperienceVersionsView` / dashboard の 2 節）は**入れ子の節**で、親が `h1` を
 * 持っている。ファイルを数えると**過大に出て、直す必要のないものを直すことになる**。
 * `src/app/admin/**\/page.tsx` から辿るのが正しい単位。
 */
function pageRendersH1(pageFile: string): boolean | null {
  const source = readFileSync(pageFile, 'utf8');
  if (source.includes('<h1')) return true;
  const imports = [...source.matchAll(/import \{ (\w+) \} from '@\/components\/admin\/[\w/]+'/g)];
  for (const [, name] of imports) {
    const candidates = findFiles(ADMIN_COMPONENTS, (f) => f === `${name}.tsx`);
    const file = candidates[0];
    if (!file) continue;
    const componentSource = readFileSync(file, 'utf8');
    if (componentSource.includes('<h1')) return true;
    // `Section` をページ根に使う画面は headingLevel="h1" で h1 を出す。
    if (componentSource.includes('headingLevel="h1"')) return true;
    return false;
  }
  return null; // 描画するコンポーネントを解決できなかった
}

describe('管理画面の見出し構造 (#890 / 課題 16)', () => {
  const pages = findFiles(ADMIN_PAGES, (f) => f === 'page.tsx');

  it('ページを 20 件以上見ている（走査が空振りしていない＝下界）', () => {
    expect(pages.length).toBeGreaterThanOrEqual(20);
  });

  it('全ページ根が h1 から始まる', () => {
    const missing = pages
      .filter((p) => pageRendersH1(p) === false)
      .map((p) => relative(ADMIN_PAGES, p));
    expect(
      missing,
      'ページ根が h2 から始まると、スクリーンリーダーの見出しジャンプで「この画面は何か」に\n' +
        '辿り着けない。Section をページ根に使うなら headingLevel="h1" を渡すこと。',
    ).toEqual([]);
  });
});

describe('管理画面のモーダル (#890 / 課題 15)', () => {
  const components = findFiles(ADMIN_COMPONENTS, (f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'));
  const withDialog = components.filter((f) => readFileSync(f, 'utf8').includes('role="dialog"'));

  it('admin にモーダルが在る（走査が空振りしていない＝下界）', () => {
    expect(withDialog.length).toBeGreaterThan(0);
  });

  it.each(withDialog.map((f) => relative(ADMIN_COMPONENTS, f)))(
    '%s のモーダルは focus 管理を持つ',
    (key) => {
      const source = readFileSync(resolve(ADMIN_COMPONENTS, key), 'utf8');
      /*
        `role="dialog"` を宣言しながら trap も Escape も持たない状態を落とす。
        共有フック（`useModalDialog`）を通していることを要求する —— 各画面が自前で
        書き直すと、また 1 つだけ抜ける（`AdminShell` が Escape を実装済みなのに
        `DevicesManager` へ写されていなかった、というのが今回の形）。
      */
      expect(source, `${key} が useModalDialog を通していない`).toContain('useModalDialog');
      // 見出しへの関連付け。宣言だけして紐づけないと支援技術は名前を読めない。
      expect(source, `${key} に aria-labelledby が無い`).toContain('aria-labelledby');
    },
  );

  it('共有フックが focus 復帰まで面倒を見る（下界: trap だけの実装を落とす）', () => {
    const hook = readFileSync(resolve(ADMIN_COMPONENTS, 'useModalDialog.ts'), 'utf8');
    expect(existsSync(resolve(ADMIN_COMPONENTS, 'useModalDialog.ts'))).toBe(true);
    // 閉じたときに開く前の要素へ返す。抜けるとフォーカスが body へ落ちる。
    expect(hook, 'focus 復帰が無い').toContain('restoreTo');
    expect(hook, 'Escape を見ていない').toContain("'Escape'");
    expect(hook, 'Tab を見ていない').toContain("'Tab'");
  });
});
