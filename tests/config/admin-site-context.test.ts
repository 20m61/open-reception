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

/**
 * その画面が拠点という次元を扱っている印。
 *
 * 当初は `useSiteScope|resolveSelectedSiteId`（= URL から読む画面）で判定していたが、
 * それは**すでに登録済みの 5 画面と完全に一致する集合**で、宣言（「本文は拠点別なのに
 * ヘッダが黙る画面を作らせない」）に対して**新しい漏れをほぼ拾わない**検出器だった
 * （#552 レビュー P2）。拠点を扱うかどうかで見る。
 */
const HANDLES_SITE = /siteId/;

/**
 * **拠点次元を持つのにヘッダが黙る画面**（既知の未対応）。
 *
 * これらは拠点を本文で扱う（多くは component state か既定固定で、URL にも載っていない）。
 * ヘッダに出すには先に「その画面の拠点を URL の真実源へ載せる」必要があり、#423 の残増分。
 * ここに載せるのは**黙らせるためではなく、増えたら落とすため**:
 *  - 登録済みパスをここへ書くと落ちる（直したら消し忘れない）
 *  - 拠点を扱わなくなったパスが残っても落ちる（腐らせない）
 *  - 新しい画面はどちらにも無いので落ちる（見逃さない）
 */
const SITE_DIMENSION_WITHOUT_HEADER: readonly string[] = [
  '/admin/demo',
  '/admin/experience-versions',
  '/admin/reservations',
  '/admin/signage',
  '/admin/sites',
  '/admin/staff-response',
  '/admin/stay',
];

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

  it('拠点を扱う画面は、ヘッダ対応済みか既知の未対応かのどちらかに必ず載っている', () => {
    const handlesSite = SCREENS.filter(({ file }) => HANDLES_SITE.test(sourcesOfScreen(file))).map(
      ({ route }) => route,
    );

    // 走査が壊れて 0 件になれば「常に緑」の無意味な検査になる。
    expect(handlesSite.length).toBeGreaterThanOrEqual(12);

    const unaccounted = handlesSite.filter(
      (route) =>
        !SITE_SCOPED_PATHS.includes(route) && !SITE_DIMENSION_WITHOUT_HEADER.includes(route),
    );
    expect(unaccounted).toEqual([]);
  });

  it('既知の未対応リストが腐っていない', () => {
    const handlesSite = new Set(
      SCREENS.filter(({ file }) => HANDLES_SITE.test(sourcesOfScreen(file))).map(({ route }) => route),
    );
    for (const route of SITE_DIMENSION_WITHOUT_HEADER) {
      // 直したのにリストへ残っている（＝ヘッダ対応済みなのに未対応と書いてある）
      expect(SITE_SCOPED_PATHS.includes(route), `${route} は対応済みなのでリストから外す`).toBe(false);
      // 拠点を扱わなくなったのに残っている
      expect(handlesSite.has(route), `${route} はもう拠点を扱っていないのでリストから外す`).toBe(true);
    }
  });

  it('登録されたパスは実在する画面を指す', () => {
    const routes = new Set(SCREENS.map((s) => s.route));
    for (const path of SITE_SCOPED_PATHS) {
      expect(routes.has(path), `${path} に対応する page.tsx が無い`).toBe(true);
    }
  });
});

describe('ヘッダの対象拠点表示の配線 (#423)', () => {
  it('拠点別画面はサーバ解決の既定拠点を props で渡す', () => {
    // ヘッダ（layout）は `resolveDefaultScope().siteId` を渡す。本文側が component の
    // ハードコード既定に頼ると、`OPEN_RECEPTION_DEFAULT_SITE_ID` を上書きした環境で
    // **ヘッダと本文が別の拠点を指す**（#552 レビュー P2。実際に 2 画面がそうだった）。
    const pagesWithBody = SITE_SCOPED_PATHS.filter((p) => !p.includes('['));
    expect(pagesWithBody.length).toBeGreaterThanOrEqual(5);
    for (const href of pagesWithBody) {
      const src = readFileSync(
        resolve(ADMIN_APP_DIR, `${href.replace(/^\/admin\//, '')}/page.tsx`),
        'utf8',
      );
      // 書き方は 2 通りある（`resolveDefaultScope().siteId` と `const scope = resolveDefaultScope()`）。
      // 見るのは「サーバ解決の既定拠点を props で渡しているか」。
      expect(src, `${href} が resolveDefaultScope を使っていない`).toContain('resolveDefaultScope');
      expect(src, `${href} が siteId を渡していない`).toMatch(/siteId=\{/);
    }
  });

  it('admin layout が対象拠点チップを描画する', () => {
    // 純関数と component が在っても、layout に置かれていなければ 1 画面も表示されない
    // （「消費者ゼロの契約」を作らない）。
    const layout = readFileSync(resolve(ADMIN_APP_DIR, 'layout.tsx'), 'utf8');
    expect(layout).toContain('SiteContextChip');
  });
});
