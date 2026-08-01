import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SITE_SCOPED_PATHS } from '../../src/components/admin/site-destinations';

/**
 * **「本文は拠点別なのにヘッダは何も出さない」画面を作らせない** (issue #423)。
 *
 * ヘッダの対象拠点表示（`site-context.ts`）は `SITE_SCOPED_PATHS` を単一情報源にしている。
 * 拠点別画面を足したときにこの登録を忘れると、その画面だけ「いまどの拠点を見ているか」が
 * ヘッダから消える — 本リポジトリが繰り返してきた
 * **「ある次元で解いた対策を、別の画面へ写していない」**形そのもの。規律では抜けるので、
 * 実ファイルを走査して機械的に落とす（`admin-tenant-scope.test.ts` と同じ考え方）。
 *
 * 判定基準は「その画面が URL から拠点を読むか」＝ `useSiteScope` /
 * `resolveSelectedSiteId` を（直接または描画する component 経由で）使っているか。
 */

const ADMIN_APP_DIR = resolve(process.cwd(), 'src/app/admin');
const ADMIN_COMPONENTS_DIR = resolve(process.cwd(), 'src/components/admin');

/** URL から拠点を読んでいることの印。 */
const READS_SITE_FROM_URL = /useSiteScope|resolveSelectedSiteId/;

/** `src/app/admin` 配下の全 page.tsx を（ネストも含め）集める。 */
function adminPages(dir = ADMIN_APP_DIR, route = '/admin'): { route: string; file: string }[] {
  const found: { route: string; file: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...adminPages(child, `${route}/${entry.name}`));
    } else if (entry.name === 'page.tsx') {
      found.push({ route, file: child });
    }
  }
  return found;
}

/** `@/components/admin/...` からの import を辿って、その画面が読むソースを集める。 */
function sourcesOfScreen(file: string): string {
  const seen = new Set<string>();
  const collect = (path: string, depth: number): string => {
    if (depth > 3 || seen.has(path)) return '';
    seen.add(path);
    let src: string;
    try {
      src = readFileSync(path, 'utf8');
    } catch {
      return '';
    }
    const imports = [...src.matchAll(/from '(?:@\/components\/admin|\.)\/([\w./-]+)'/g)].map(
      (m) => m[1],
    );
    return (
      src +
      imports
        .map((name) => {
          for (const ext of ['.tsx', '.ts']) {
            const candidate = resolve(ADMIN_COMPONENTS_DIR, `${name}${ext}`);
            const child = collect(candidate, depth + 1);
            if (child !== '') return child;
          }
          return '';
        })
        .join('\n')
    );
  };
  return collect(file, 0);
}

const SCREENS = adminPages();

describe('拠点別画面の登録漏れ検出 (#423)', () => {
  it('走査が空振りしていない', () => {
    expect(SCREENS.length).toBeGreaterThanOrEqual(10);
  });

  it('URL から拠点を読む画面はすべて SITE_SCOPED_PATHS に載っている', () => {
    const readsSite = SCREENS.filter(({ file }) => READS_SITE_FROM_URL.test(sourcesOfScreen(file)))
      .map(({ route }) => route)
      // 動的セグメントは登録簿のパターン表記に合わせる。
      .map((route) => route.replace(/\/\[/g, '/[').trim());

    // 走査が壊れて 0 件になれば「常に緑」の無意味な検査になる。
    expect(readsSite.length).toBeGreaterThanOrEqual(5);

    const missing = readsSite.filter((route) => !SITE_SCOPED_PATHS.includes(route));
    expect(missing).toEqual([]);
  });

  it('登録されたパスは実在する画面を指す', () => {
    const routes = new Set(SCREENS.map((s) => s.route));
    for (const path of SITE_SCOPED_PATHS) {
      expect(routes.has(path), `${path} に対応する page.tsx が無い`).toBe(true);
    }
  });
});

describe('ヘッダの対象拠点表示の配線 (#423)', () => {
  it('admin layout が対象拠点チップを描画する', () => {
    // 純関数と component が在っても、layout に置かれていなければ 1 画面も表示されない
    // （「消費者ゼロの契約」を作らない）。
    const layout = readFileSync(resolve(ADMIN_APP_DIR, 'layout.tsx'), 'utf8');
    expect(layout).toContain('SiteContextChip');
  });
});
