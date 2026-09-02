import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 破壊的操作に**生の `window.confirm` を使わない** (#888 / 課題 08)。
 *
 * ## なぜ native dialog では駄目か
 *
 * `window.confirm` は**無スタイル・翻訳不可・フォーカス管理なし**で、押し間違いを止める段階が
 * 1 つも無い。そして最も重要な点として、**理由が監査に残らない**。
 * 受付端末に何が出るかを変える「本番 Kiosk へ公開」「version rollback」が、ブラウザ既定の
 * ダイアログ 1 つで実行できていた。
 *
 * 二段確認プリミティブ（`DangerActionButton` / `confirm-flow`）は #91 で既に在り、影響範囲 ack・
 * 理由入力・確認文言まで宣言的に要求できる。**消費者が platform の 1 箇所だけだった**のが問題で、
 * 作られたのに使われていない典型である。
 *
 * ## 登録簿にする理由
 *
 * 「今ある 8 箇所を直した」だけでは、次に破壊的操作を足す人がまた `window.confirm` と書く。
 * **admin 配下に生 confirm が現れたら落とす**形にして、増える側を止める。
 */
const ADMIN_DIR = resolve(process.cwd(), 'src/components/admin');

/** 生の確認ダイアログ。`window.` 無しの `confirm(` も拾う。 */
const RAW_CONFIRM = /(?:^|[^.\w])(?:window\.)?confirm\s*\(/g;

/** コメントを落とす（説明の散文が自分の検査に当たるのを避ける）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function findTsx(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findTsx(path));
    else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) found.push(path);
  }
  return found;
}

const SCREENS = findTsx(ADMIN_DIR).map((path) => ({
  key: relative(ADMIN_DIR, path),
  hits: (stripComments(readFileSync(path, 'utf8')).match(RAW_CONFIRM) ?? []).length,
}));

describe('破壊的操作の確認 (#888)', () => {
  it('走査が admin の画面を 20 件以上見ている（空振りしていない＝下界）', () => {
    expect(SCREENS.length).toBeGreaterThanOrEqual(20);
  });

  it('生の window.confirm が 1 つも残っていない', () => {
    const offenders = SCREENS.filter((s) => s.hits > 0).map((s) => `${s.key} (${s.hits})`);
    expect(
      offenders,
      '破壊的操作は DangerActionButton（components/admin/danger/）を通すこと。\n' +
        'native dialog は無スタイル・翻訳不可・フォーカス管理なしで、理由が監査に残らない。',
    ).toEqual([]);
  });

  it('二段確認プリミティブに admin 側の消費者が居る（作って使わない、を防ぐ＝下界）', () => {
    // 上の検査は「破壊的操作を全部消す」でも通る。実際に使われていることを併せて縛る。
    const consumers = SCREENS.filter((s) =>
      readFileSync(resolve(ADMIN_DIR, s.key), 'utf8').includes('DangerActionButton'),
    );
    expect(consumers.length, 'DangerActionButton の消費者が admin に無い').toBeGreaterThan(0);
  });
});
