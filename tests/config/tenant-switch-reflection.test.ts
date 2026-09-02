import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * テナント切替の**反映方法**を、どの切替 UI でも同じにする (#870 増分 01)。
 *
 * ## 何が起きていたか
 *
 * `admin/TenantSwitcher.tsx` は切替後に `router.refresh()` だけを呼んでいた。しかし管理画面の
 * 11 コンポーネントは `useCallback(..., [])` の mount 時 fetch で読むため、**server component の
 * 再レンダリングでは再取得されない**。運用者にはヘッダのテナント名だけが変わって見え、本文は
 * 前テナントのデータのまま残る。**その状態で編集すると、切替後テナントへ書き込まれる。**
 *
 * ## なぜ「写し忘れ」なのか
 *
 * **同じ欠陥は platform 側で診断済みだった。** `admin/platform/TenantSwitcher.tsx` は
 * `window.location.reload()` にしており、コメントに理由まで書いてある:
 *
 * > platform の各 read はクライアントで mount 時に fetch するため、router.refresh() では
 * > 再取得されない。
 *
 * その修正が admin へ写されていなかった。本リポジトリが繰り返してきた
 * **「ある次元で解いた対策を別の次元へ写していない」**形そのもの。
 *
 * ## なぜファイルを列挙せず走査するのか
 *
 * 2 つを名指しすると、**3 つ目の切替 UI が増えたときに素通りする**。それこそが今回の型
 * （片方だけ直って、もう片方が取り残される）なので、`TenantSwitcher.tsx` を実ファイルから
 * 集めて全部に同じ条件を課す。
 *
 * 実ブラウザでの検証は seed が単一テナントのため書けない（`platform-viewing-context.spec.ts`
 * の「選択中と別のテナント」テストが同じ理由で skip されている）。プロジェクトに jsdom/RTL が
 * 無く `onSelect` を発火させる手段も無いので、構造で縛る。
 */
const COMPONENTS = resolve(process.cwd(), 'src/components');

/** `src/components/**\/TenantSwitcher.tsx` を実ファイルから集める。 */
function findSwitchers(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findSwitchers(path));
    else if (entry.name === 'TenantSwitcher.tsx') found.push(path);
  }
  return found;
}

/** コメントを落とす。理由を説明した散文が検査に引っかかるのを避ける（#869 で踏んだ型）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const SWITCHERS = findSwitchers(COMPONENTS).map((path) => ({
  // テスト名に出るので repo 相対にする（絶対パスは環境で変わり、失敗の読み取りを妨げる）。
  path: relative(process.cwd(), path),
  code: stripComments(readFileSync(path, 'utf8')),
}));

describe('テナント切替の反映方法 (#870 増分 01)', () => {
  it('切替 UI を 2 つ以上見つけている（走査が空振りしていない＝下界）', () => {
    // 走査が 0 件を返すと、以下の検査は全部空虚に通る。
    expect(SWITCHERS.length).toBeGreaterThanOrEqual(2);
  });

  it.each(SWITCHERS.map((s) => s.path))(
    '%s は切替後にフルリロードする（mount 時 fetch の read を確実に取り直す）',
    (path) => {
      const target = SWITCHERS.find((s) => s.path === path);
      expect(
        target?.code,
        'router.refresh() では useCallback(..., []) の read が再取得されない。' +
          'window.location.reload() で全画面の read を取り直す',
      ).toContain('window.location.reload()');
    },
  );

  it.each(SWITCHERS.map((s) => s.path))(
    '%s は router.refresh() に頼らない（それだけでは本文が前テナントのまま残る）',
    (path) => {
      const target = SWITCHERS.find((s) => s.path === path);
      expect(target?.code).not.toContain('router.refresh()');
    },
  );
});
