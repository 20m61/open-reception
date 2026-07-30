import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 「表示中テナント」の pathname 取得元を固定する静的メタテスト (#423)。
 *
 * 第 85 wave は `/platform/layout.tsx` が `x-or-pathname` ヘッダから読んだ pathname を
 * `TenantSwitcher` へ prop で渡していた。しかし一覧 → 詳細は `next/link` のクライアント遷移で、
 * **App Router はセグメントを跨がない layout を再レンダリングしない**。そのため prop は一覧の
 * pathname のまま固まり、「表示中: <テナント名>」はハードロード時しか出なかった。
 *
 * この欠陥は純関数（`resolveViewingContext`）の unit では検出できない（純関数は正しかった）。
 * 検出したのは **Link をクリックする e2e** で、それは developer セッションを張れず skip されていた
 * （`tests/e2e/platform-viewing-context.spec.ts` / `playwright.config.ts` の platform-developer）。
 * e2e が本体の防波堤だが、ここでも「layout から渡し直す」退行を安く塞いでおく。
 */
const ROOT = join(import.meta.dirname, '../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('platform TenantSwitcher: pathname はクライアントで取る', () => {
  it('TenantSwitcher は usePathname を使う', () => {
    const src = read('components/admin/platform/TenantSwitcher.tsx');
    expect(src).toContain("from 'next/navigation'");
    expect(src).toContain('usePathname(');
  });

  it('platform layout は pathname を TenantSwitcher へ渡さない', () => {
    const src = read('app/platform/layout.tsx');
    // `<TenantSwitcher ... />` に pathname prop を復活させない（クライアント遷移で stale になる）。
    expect(src).toMatch(/<TenantSwitcher\s*\/>/);
    expect(src).not.toMatch(/<TenantSwitcher[^/>]*pathname=/);
  });
});
