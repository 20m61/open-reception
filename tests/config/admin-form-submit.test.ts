import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * admin の CRUD が `<form>` として送信できる (#892 / 課題 13)。
 *
 * `Field.test.tsx` が部品の振る舞いを、`tests/e2e/admin-form-enter-submit.spec.ts` が
 * 実ブラウザでの Enter 送信を縛る。ここが見るのは**構造の退行**——
 * 変換済みの画面が `<div>` + `onClick` へ戻ること、および
 * 「`<form>` にはしたが送信ボタンが無い」（＝ Enter で何も起きないまま形だけ整う）状態。
 */

const ADMIN_DIR = join(process.cwd(), 'src/components/admin');

/** 変換済みの画面と、その送信ボタンの testId。 */
const CONVERTED: readonly { readonly file: string; readonly submit: string }[] = [
  { file: 'SitesManager.tsx', submit: 'site-add' },
  { file: 'DepartmentsManager.tsx', submit: 'dept-add' },
  { file: 'StaffManager.tsx', submit: 'staff-add' },
  { file: 'AssetsManager.tsx', submit: 'asset-add' },
  { file: 'RoutingPolicyManager.tsx', submit: 'endpoint-add' },
  { file: 'ReservationsManager.tsx', submit: 'rsv-create' },
  { file: 'DevicesManager.tsx', submit: 'device-add' },
];

/** 注記が主張と一致してしまう事故を避けるため、コメントを落としてから走査する。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function read(file: string): string {
  return stripComments(readFileSync(join(ADMIN_DIR, file), 'utf8'));
}

/** admin 配下の .tsx を再帰的に集める。 */
function adminFiles(dir = ADMIN_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return adminFiles(path);
    return e.isFile() && e.name.endsWith('.tsx') && !e.name.includes('.test.') ? [path] : [];
  });
}

/** `<Form ...>` から対応する `</Form>` までを粗く切り出す（入れ子は使っていない）。 */
function formBodies(source: string): string[] {
  return [...source.matchAll(/<Form\b[\s\S]*?<\/Form>/g)].map((m) => m[0]);
}

describe('admin CRUD の form 化 (#892 / 課題 13)', () => {
  it.each(CONVERTED)('$file は Form を使い、$submit が submit ボタンである', ({ file, submit }) => {
    const source = read(file);
    expect(source).toContain("from '@/components/admin/ui'");
    expect(source).toMatch(/<Form\b/);

    const button = new RegExp(`<Button[^>]*data-testid="${submit}"[^>]*>`, 's').exec(source)?.[0];
    expect(button, `${submit} のボタンが見つからない`).toBeTruthy();
    expect(button).toContain('type="submit"');
    /*
     * 下界: `onClick` が残っていないこと。残したままでも動くが、送信経路が 2 本になり
     * 「クリックでは動くが Enter では動かない」退行がテストを素通りする。
     */
    expect(button).not.toContain('onClick');
  });

  it('Form を持つ画面には必ず submit ボタンがある（形だけの form を作らない）', () => {
    const offenders = adminFiles()
      .map((path) => ({ path, source: stripComments(readFileSync(path, 'utf8')) }))
      .filter(({ source }) => /<Form\b/.test(source))
      .filter(({ source }) => !formBodies(source).every((body) => body.includes('type="submit"')));
    expect(offenders.map((o) => o.path)).toEqual([]);
  });

  it('Form の中の生 <button> は type を明示する（既定の submit で誤送信しない）', () => {
    const offenders = adminFiles().flatMap((path) => {
      const source = stripComments(readFileSync(path, 'utf8'));
      return formBodies(source)
        .flatMap((body) => [...body.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]))
        .filter((tag) => !/\btype=/.test(tag))
        .map((tag) => `${path}: ${tag}`);
    });
    expect(offenders).toEqual([]);
  });

  it('Form 部品そのものが遷移を止め、レイアウトを動かさない', () => {
    const source = stripComments(readFileSync(join(ADMIN_DIR, 'ui/Form.tsx'), 'utf8'));
    // 遷移を止める（書き忘れると「動くが画面が真っさらになる」形で出る）。
    expect(source).toContain('preventDefault');
    // ブラウザ既定の制約検証を後から足さない（変換前に通っていた送信を黙って止めないため）。
    expect(source).toContain('noValidate');
    // `<form>` の UA 既定 margin を打ち消す。VRT ベースラインを動かさないための条件。
    expect(source).toContain('margin: 0');
  });
});
