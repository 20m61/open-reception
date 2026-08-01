import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SITE_SCOPED_PATHS } from '../../src/components/admin/site-destinations';

/**
 * **拠点別画面が「選択中テナント」を使っていることを構造的に強制する** (issue #421)。
 *
 * 拠点 ID はテナント内スコープなので、テナントを既定固定にすると、テナントを切り替えた
 * developer / 複数テナント管理者に対して「その拠点は無い」と誤表示するか、**同じ ID が
 * 既定テナントにも在れば別テナントの設定を表示・操作させてしまう**。
 *
 * この誤りは画面を足すたびに再発する（実際 #421 の増分 1〜4 で 5 画面すべてが
 * 既定テナント固定のまま作られ、拠点詳細だけがレビューで是正された）。**規律では抜ける**ので、
 * 実ファイルを走査して機械的に落とす。`navigation.test.ts` が「作った画面がナビから辿れない」
 * を強制しているのと同じ考え方。
 */

/**
 * 拠点別画面（`site-destinations.ts` で拠点を運ぶと宣言しているもの）＋拠点詳細。
 *
 * **本番コードの `SITE_SCOPED_PATHS` を借りる** (#423)。ここで独自に列挙すると、
 * ヘッダの対象拠点表示（`site-context.ts`）が見る集合と食い違い、「本文は拠点別なのに
 * ヘッダは何も出さない」画面が検査をすり抜ける。
 */
const SITE_SCOPED_PAGES = SITE_SCOPED_PATHS;

function pageSource(href: string): string {
  const rel = href.replace(/^\/admin\//, '');
  return readFileSync(resolve(process.cwd(), `src/app/admin/${rel}/page.tsx`), 'utf8');
}

describe('拠点別画面のテナント解決 (#421)', () => {
  it('対象がゼロ本になっていない（走査が空振りしていない）', () => {
    // 登録簿の形が変わって 0 件になると、この検査は「常に緑」の無意味な検査になる。
    expect(SITE_SCOPED_PAGES.length).toBeGreaterThanOrEqual(5);
  });

  it.each(SITE_SCOPED_PAGES)('%s は選択中テナントを解決する', (href) => {
    const src = pageSource(href);
    expect(src).toContain('resolveAdminTenantId');
  });

  it.each(SITE_SCOPED_PAGES)('%s はテナントを既定スコープで決め打たない', (href) => {
    const src = pageSource(href);
    // `resolveDefaultScope` は拠点の既定値としては使ってよいが、**テナント**を
    // これで決めると TenantSwitcher の選択から外れる。ヘルパ経由に寄せる。
    expect(src).not.toMatch(/resolveDefaultScope\(\)\.tenantId/);
  });
});
