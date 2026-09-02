import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';
import {
  ADMIN_NAV,
  UNLISTED_ADMIN_ROUTES,
  UNLISTED_ADMIN_TITLES,
} from '../../src/components/admin/navigation';
import { SITE_SCOPED_PATHS } from '../../src/components/admin/site-destinations';

/**
 * 旧「呼び出しルート」画面の撤去を機械で固定する (#873)。
 *
 * これは仕様判断ではなく**終わっていない廃止作業**だった。`/admin/call-routes` は
 * 設定しても実通話に一切効かない（実発信は `executeRoutedCall` → RoutingPolicy /
 * ContactEndpoint、#374）のに、編集できる状態で到達可能なまま残っていた。運用者は
 * 取次を設定したつもりで、何も起きない。
 *
 * #421 はナビから外しただけで画面を残した（受付フローの `callRouteId` が生きていたため）。
 * その参照は `normalize.ts` の `RETIRED_KEYS` で撤去済みで、`routing/compat.ts` の本番
 * 消費者もゼロになった。よって今回は**消す**。
 *
 * ## なぜ「存在しないこと」を書くのか
 *
 * 削除は差分では守れない。ファイルを消しただけでは、次の周回が「旧画面が要る」と判断して
 * 復活させても誰も気づかない。復活させるなら、この検査ごと直させる。
 *
 * **下界を併せて縛る**（`CLAUDE.md` 検証の作法）。「消えていること」だけを主張する検査は
 * **取次の画面が全部壊れた世界でも通る**ので、正となる `/admin/call-routing` が生きて
 * いることも同時に要求する。
 */
const ROOT = process.cwd();

/** 消えたはずのもの。パスは実体で、basename では書かない。 */
const REMOVED = [
  'src/app/admin/call-routes',
  'src/components/admin/CallRoutesManager.tsx',
  'src/domain/routing/compat.ts',
  'src/domain/routing/compat.test.ts',
] as const;

/** 下界: 正となる取次の画面と、その土台。ここが消えたら「全部消した」ことになる。 */
const KEPT = [
  'src/app/admin/call-routing/page.tsx',
  'src/components/admin/RoutingPolicyManager.tsx',
  'src/domain/routing/policy.ts',
  'src/domain/routing/endpoint.ts',
] as const;

describe('旧「呼び出しルート」画面の撤去 (#873)', () => {
  it('旧画面・旧 component・compat リーダが存在しない', () => {
    for (const path of REMOVED) {
      expect(existsSync(resolve(ROOT, path)), `${path} が残っている`).toBe(false);
    }
  });

  it('正となる取次の画面は生きている（「全部消した」で通らないための下界）', () => {
    for (const path of KEPT) {
      expect(existsSync(resolve(ROOT, path)), `${path} が消えている`).toBe(true);
    }
  });

  it('旧 URL は正の画面へ恒久 redirect する（ブックマーク・手打ちを 404 にしない）', async () => {
    const redirects = await nextConfig.redirects?.();
    expect(redirects, 'next.config に redirects が無い').toBeDefined();
    const hit = (redirects ?? []).find((r) => r.source === '/admin/call-routes');
    expect(hit, '/admin/call-routes の redirect が無い').toBeDefined();
    expect(hit?.destination).toBe('/admin/call-routing');
    // 恒久（308）にする。一時 redirect だと検索/ブラウザが旧 URL を覚え続ける。
    expect(hit?.permanent).toBe(true);
  });

  it('旧ルートがナビにも非掲載登録にも残っていない', () => {
    const navHrefs = ADMIN_NAV.flatMap((g) => g.items.map((i) => i.href));
    expect(navHrefs).not.toContain('/admin/call-routes');
    // 非掲載登録は「到達可能だがナビに出さない」画面のためのもの。消した画面が残ると、
    // `navigation.test.ts` の実在検査と矛盾したまま腐る。
    expect(Object.keys(UNLISTED_ADMIN_ROUTES)).not.toContain('/admin/call-routes');
    expect(Object.keys(UNLISTED_ADMIN_TITLES)).not.toContain('/admin/call-routes');
    expect(SITE_SCOPED_PATHS).not.toContain('/admin/call-routes');
  });

  it('非掲載登録の仕組み自体は生きている（旧受付端末はまだ残す）', () => {
    // 下界。上の検査は「非掲載登録を全部空にする」でも通ってしまう。
    // `/admin/kiosks` は token 発行の旧フローが生きているので、こちらは消さない。
    expect(Object.keys(UNLISTED_ADMIN_ROUTES)).toContain('/admin/kiosks');
    expect(existsSync(resolve(ROOT, 'src/app/admin/kiosks/page.tsx'))).toBe(true);
  });
});

/**
 * 取次の概念に名前を 1 つだけ残す (#873)。
 *
 * 削除前は同じものに 3 つの名前が並んでいた:
 *   ナビ「取次ルート」 / 画面見出し「呼び出しルート（文章形式）」 / 旧画面「呼び出しルート（旧）」。
 * 運用者が「呼び出しルート」でサイドバーを探しても見つからない。
 *
 * 逐語で固定するのではなく、**ナビのラベルと画面の見出しが一致すること**を縛る。片方だけ
 * 推敲しても落ちる（名前が 2 つに増えた瞬間が検出できる）。
 */
const ROUTING_MANAGER = resolve(ROOT, 'src/components/admin/RoutingPolicyManager.tsx');

/**
 * コメントを落としてから走査する。
 *
 * **説明文が自分の検査に引っかかる**型を避けるため（#869 で同じ失敗を踏んだ: ガードが
 * 「なぜそう書くか」を説明したコメント中の `--font-sm` を拾って落ちた）。旧名称は
 * 「なぜ変えたか」を書くために本文中で引用する必要があり、引用を消して検査を通すのは
 * **説明を捨てて検査に合わせる**ことになる。落とすべきは描画される文字列だけ。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('取次の名称統一 (#873)', () => {
  const source = readFileSync(ROUTING_MANAGER, 'utf8');
  const rendered = stripComments(source);

  it('ナビのラベルと画面の h1 が同じ名前', () => {
    const navLabel = ADMIN_NAV.flatMap((g) => g.items).find(
      (i) => i.href === '/admin/call-routing',
    )?.label;
    expect(navLabel, 'ナビに /admin/call-routing が無い').toBeDefined();
    const h1 = /<h1[^>]*>([^<]+)<\/h1>/.exec(rendered)?.[1]?.trim();
    expect(h1, '画面に h1 が無い').toBeDefined();
    expect(h1).toBe(navLabel);
  });

  it('旧名称「呼び出しルート」を描画しない（説明コメントでの引用は許す）', () => {
    expect(rendered).not.toContain('呼び出しルート');
    // 下界: コメント除去が効きすぎて全部消えていないこと。空文字列は上を空虚に満たす。
    expect(rendered).toContain('取次ルート');
  });

  it('旧画面への導線が消えている', () => {
    expect(rendered).not.toContain('routing-legacy-call-routes-link');
    expect(rendered).not.toContain('routing-legacy-call-routes-pending');
    expect(rendered).not.toContain('/admin/call-routes');
  });

  it('見出しが入れ子で重複しない（h1 と同じ文字列の h2 を作らない）', () => {
    const h1 = /<h1[^>]*>([^<]+)<\/h1>/.exec(rendered)?.[1]?.trim();
    const h2s = [...rendered.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1]?.trim());
    // 下界: 節見出しそのものは残っていること（「全部消した」で通らないため）。
    expect(h2s.length).toBeGreaterThanOrEqual(2);
    expect(h2s, 'h1 と同じ名前の h2 がある').not.toContain(h1);
  });
});
