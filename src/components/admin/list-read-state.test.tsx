import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

/*
 * 管理画面は `useSearchParams` で一覧の状態（検索・並べ替え・ページ）を URL に持つ (#94)。
 * app router の context 無しに描くと投げるので、**読み取り専用の最小実装**を差し込む。
 * ここで見たいのは「fetch より前の描画」なので、URL は空で構わない。
 */
vi.mock('next/navigation', () => ({
  usePathname: () => '/admin',
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(''),
}));

import { AssetsManager } from './AssetsManager';
import { DepartmentsManager } from './DepartmentsManager';
import { OrganizationsManager } from './OrganizationsManager';
import { StaffManager } from './StaffManager';

/**
 * 管理画面の一覧が、**配線として**「まだ読めていない」を出す (#966 AC1 / AC4)。
 *
 * ## なぜ構造ガードだけでは足りないか
 *
 * `tests/config/admin-list-states.test.ts` は「`loaded` / `failed` を対で渡している」ことを
 * ソースの文字列で見る。#896 の独立レビューが実測したとおり、それは
 * `loaded={items !== null}` → `loaded`（＝定数 `true`）という**配線の変異で満たせてしまう**。
 * `.claude/rules/opus5-autonomous-loop.md`「方式を替えたら〜」が名指しする #826 と同型で、
 * 部品（`DataTable`）だけに変異を当てて「kill した」と言っても、**呼び出し側の配線**は
 * 縛れていない。ここは部品ではなく**画面**を描き、実際に出た DOM を読む。
 *
 * ## なぜ「読み込み中」だけを見るのか
 *
 * このリポジトリに jsdom / testing-library は無く、`renderToStaticMarkup` は `useEffect` を
 * 走らせない。したがって観測できるのは **`fetch` 前の初期状態**（`items === null`）である。
 * それで十分に効く —— `loaded` を定数 `true` へ変異させると初期状態が `'loaded'` と判定され、
 * 「〜はありません。」と**断定**するのでここが落ちる。`failed` 側（定数化）は
 * `tests/config/admin-list-states.test.ts` の「定数ではなく式へ束ねる」で縛る。**2 つで 1 組**。
 */
const LISTS: readonly {
  readonly label: string;
  readonly element: ReactElement;
  readonly testId: string;
  /** 取得前に出てはいけない断定表現。`-empty` の外に出ているものを名指しする。 */
  readonly forbidden: readonly string[];
}[] = [
  {
    label: 'AssetsManager',
    element: <AssetsManager />,
    testId: 'asset-table',
    forbidden: ['登録されたアセットはありません'],
  },
  {
    label: 'DepartmentsManager',
    element: <DepartmentsManager />,
    testId: 'dept-table',
    forbidden: ['登録された部署はありません'],
  },
  {
    label: 'OrganizationsManager',
    element: <OrganizationsManager />,
    testId: 'org-table',
    // 表の外の `EmptyState` で断定していた形。#966 でここへ移した。
    forbidden: ['組織がありません', 'まず「部署管理」で部署を追加してください'],
  },
  {
    label: 'StaffManager',
    element: <StaffManager />,
    testId: 'staff-table',
    // 件数表示も断定である。「0 件中 0 件を表示」は「0 件だった」と同じことを言う。
    forbidden: ['登録された担当者はありません', '件中'],
  },
];

/** `src/components/admin` 直下（`platform/` を除く）の画面ソース。 */
function adminSources(): { name: string; source: string }[] {
  const dir = join(process.cwd(), 'src/components/admin');
  const out: { name: string; source: string }[] = [];
  const walk = (d: string, prefix: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === 'platform') continue;
        walk(path, name);
      } else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.'))
        out.push({ name, source: readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '') });
    }
  };
  walk(dir, '');
  return out;
}

describe('管理画面の一覧は配線として「読み込み中」を出す (#966 AC1)', () => {
  it.each(LISTS.map((l) => [l.label, l] as const))(
    '%s: 取得前は「読み込み中」で、0 件だと断定しない',
    (_label, list) => {
      const html = renderToStaticMarkup(list.element);
      expect(html, `${list.testId}-loading が無い`).toContain(`data-testid="${list.testId}-loading"`);
      expect(html, `${list.testId}-empty が出ている（0 件だと断定している）`).not.toContain(
        `data-testid="${list.testId}-empty"`,
      );
      for (const text of list.forbidden)
        expect(html, `取得前に「${text}」と断定している`).not.toContain(text);
    },
  );

  /*
   * 🔴 **網羅（#966 AC4 の下界）。** `LISTS` が手書きである限り、新しい一覧を足した人は
   * ここへ登録しないまま緑にできてしまう —— #896 のレビューが「件数の固定は増えない」と
   * 実測した型である。ソースを走査して「`failed` を**式**で渡している `DataTable`」を
   * 全部見つけ、漏れなく `LISTS` に載っていることを要求する。
   */
  it('🔴 網羅: failed を式で渡す DataTable は全部 LISTS に載っている', () => {
    const covered = new Set(LISTS.map((l) => l.testId));
    const wired = adminSources().flatMap((f) =>
      [...f.source.matchAll(/<DataTable\b[\s\S]*?\/>/g)]
        .map((m) => m[0])
        .filter((b) => /\bfailed=\{(?!true\}|false\})/.test(b))
        .map((b) => /testId="([^"]*)"/.exec(b)?.[1] ?? '(testId なし)'),
    );
    expect(wired.filter((t) => !covered.has(t)), 'この一覧を LISTS へ足すこと').toEqual([]);
  });

  it('🔴 下界: LISTS が実在の一覧を指している（腐った登録を残さない）', () => {
    const all = adminSources().flatMap((f) =>
      [...f.source.matchAll(/testId="([^"]*)"/g)].map((m) => m[1]),
    );
    expect(LISTS.filter((l) => !all.includes(l.testId)).map((l) => l.testId)).toEqual([]);
  });
});
