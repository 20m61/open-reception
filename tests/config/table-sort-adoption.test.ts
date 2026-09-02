import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 列ソートを入れた一覧が、黙って元へ戻らないようにする (#909 / 課題 18)。
 *
 * 並べ替えの純ロジックは `src/components/admin/table-sort.test.ts` が、実ブラウザでの
 * 挙動は `tests/e2e/admin-table-sort.spec.ts` が縛る。ここは**採用の下界**だけを見る ——
 * 「`DataTable` にソートの口を付けたが誰も使っていない」状態を緑にしない。
 */

const ROOT = process.cwd();

/** 並べ替えを入れた一覧。増えるのは歓迎、減るのは退行。 */
const ADOPTED: readonly string[] = [
  'src/components/admin/audit/AuditLogViewer.tsx',
  'src/components/admin/receptions/ReceptionsViewer.tsx',
  'src/components/admin/SitesManager.tsx',
];

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

describe('列ソートの採用 (#909 / 課題 18)', () => {
  it.each(ADOPTED)('%s が並べ替えを配線している', (path) => {
    const source = read(path);
    expect(source).toContain('useTableSort');
    expect(source).toContain('sortRows');
    expect(source).toMatch(/onSortChange=\{setSort\}/);
    // 少なくとも 1 列がソート可能である（口だけ付けて列に付けない、を落とす）。
    expect(source).toMatch(/sortValue:/);
  });

  it.each(ADOPTED)('%s が並べ替えてからページを切る', (path) => {
    const source = read(path);
    /*
     * 🔴 順序が逆だと**ページを切ったあとの 20 件だけが並び替わる**。利用者からは
     * 「並べ替えたのに 2 ページ目に小さい値が残っている」という壊れ方に見える。
     * `sortRows` の呼び出しが `paginate` より前にあることを見る。
     */
    const sortAt = source.indexOf('sortRows(');
    const pageAt = source.indexOf('paginate(');
    expect(sortAt, `${path} に sortRows が無い`).toBeGreaterThan(-1);
    expect(pageAt, `${path} に paginate が無い`).toBeGreaterThan(-1);
    expect(sortAt, `${path}: paginate が sortRows より先にある`).toBeLessThan(pageAt);
  });

  it('DataTable はソート可能な列にだけ aria-sort を出す', () => {
    const source = read('src/components/admin/ui/DataTable.tsx');
    // 3 つ揃ったときだけソート可能に見せる（列の比較キー・現在の状態・遷移先）。
    expect(source).toContain('const sortable = Boolean(c.sortValue && onSortChange)');
    expect(source).toContain('aria-sort={sortable ?');
  });
});
