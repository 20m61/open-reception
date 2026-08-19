/**
 * ゲートスタンプの指紋が**ツリーの内容**を正しく表すことを固定する (#720)。
 *
 * ## なぜ要るか
 *
 * 指紋は「そのゲートが実際に検査したツリー」を表し、`scripts/hooks/pr-gate-guard.sh` が
 * **ゲート後に編集されていないこと**の根拠に使う。取りこぼすと、
 * **ゲート実行後にそのファイルを書き換えても stale と判定されず、マージが通る**。
 *
 * `core.quotePath=false` は非 ASCII を素通しするが、**`"` や改行を含むパスは
 * それでも git が引用・エスケープする**。引用された文字列は実体として見つからず
 * 「削除済み」に分類され、中身の変更が指紋に入らない（実測で再現済み）。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const LIB = resolve(process.cwd(), 'scripts/lib/gate-stamp.sh');
const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** `gate_tree_fingerprint` だけを走らせる隔離リポジトリ。 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-fingerprint-'));
  created.push(dir);
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  execFileSync('cp', [LIB, join(dir, 'scripts/lib/gate-stamp.sh')]);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  // 隔離リポジトリなので署名は要らない（環境の署名設定に依存させない）。
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  return dir;
}

function fingerprint(dir: string): string {
  return execFileSync(
    'bash',
    ['-c', '. scripts/lib/gate-stamp.sh && gate_tree_fingerprint'],
    { cwd: dir, encoding: 'utf8' },
  ).trim();
}

/** 名前に特殊文字を含むファイルも Node から直接書ける（シェルを通さない）。 */
function write(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}

describe('gate_tree_fingerprint: 特殊文字を含むパスを取りこぼさない (#720)', () => {
  it.each([
    ['引用符（中間）', 'quo"te.md'],
    ['引用符（先頭）', '"quoted.md'],
    ['改行', 'new\nline.md'],
    ['バックスラッシュ', 'back\\slash.md'],
    ['非 ASCII', '日本語.md'],
    ['空白', 'with space.md'],
  ])('🔴 %s を含むパスの中身を変えると指紋が変わる', (_label, name) => {
    // ここが変わらないと、ゲート後にそのファイルを書き換えても stale と判定されず、
    // **未検証のツリーでマージが通る**。
    const dir = makeRepo();
    write(dir, name, 'before\n');
    const before = fingerprint(dir);
    expect(before).toMatch(/^[0-9a-f]{64}$/);

    write(dir, name, 'after\n');
    expect(fingerprint(dir)).not.toBe(before);
  });

  it('🔴 行頭が引用符のパスが、復号先の同名ファイルにすり替わらない', () => {
    // 🔴 **`git hash-object --stdin-paths` は行頭 `"` を C-quote として復号する。**
    // `"a.md"` という名前のファイルは `a.md` に化け、**別ファイルのハッシュ**が
    // 記録される（exit 0 で行数も合うので `wc -l` の検査も素通りする）。
    //
    // 引用が閉じていない `"quoted.md` では `fatal: line is badly quoted` で 128 終了し
    // **フォールバックへ落ちて正しく動く**ので、そちらでは踏めない（変異で実証）。
    // **復号先が実在する**形でなければ検出できない。
    const dir = makeRepo();
    write(dir, 'a.md', 'DECOY\n');
    write(dir, '"a.md"', 'before\n');
    const before = fingerprint(dir);

    write(dir, '"a.md"', 'after\n');
    expect(fingerprint(dir)).not.toBe(before);
  });

  it('同じツリーなら同じ指紋（既存の意味を壊さない）', () => {
    const dir = makeRepo();
    write(dir, 'quo"te.md', 'x\n');
    write(dir, 'normal.md', 'y\n');
    write(dir, '日本語.md', 'z\n');
    expect(fingerprint(dir)).toBe(fingerprint(dir));
  });

  it('コミット済みでも未追跡でも中身の変更を拾う', () => {
    const dir = makeRepo();
    write(dir, 'quo"te.md', 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir });
    const committed = fingerprint(dir);

    write(dir, 'quo"te.md', 'edited\n');
    const edited = fingerprint(dir);
    expect(edited).not.toBe(committed);

    // 未追跡ファイルを足しても変わる（ゲートが検査するのは作業ツリー）。
    write(dir, 'untracked"x.md', 'new\n');
    expect(fingerprint(dir)).not.toBe(edited);
  });

  it('追跡済みファイルを消しても指紋が変わる（削除を「変更なし」にしない）', () => {
    const dir = makeRepo();
    write(dir, 'quo"te.md', 'x\n');
    write(dir, 'keep.md', 'y\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir });
    const before = fingerprint(dir);

    rmSync(join(dir, 'quo"te.md'));
    expect(fingerprint(dir)).not.toBe(before);
  });

  it('🔴 「追跡済みだが作業ツリーに無い」を「最初から無い」と区別する', () => {
    // 🔴 **上の削除テストは `missing` を固定しない。** 追跡ファイルを消すと `existing`
    // からも 1 行消えるので、`missing` セクションが無くても指紋は変わってしまう
    // （変異で実証: `missing` を落としても 8 件すべて素通りした）。
    // **ディスク上の内容が同一で index だけが違う 2 つの木**で初めて効く。
    const withMissing = makeRepo();
    write(withMissing, 'keep.md', 'y\n');
    write(withMissing, 'gone.md', 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: withMissing });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: withMissing });
    rmSync(join(withMissing, 'gone.md'));

    const neverHad = makeRepo();
    write(neverHad, 'keep.md', 'y\n');
    execFileSync('git', ['add', '-A'], { cwd: neverHad });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: neverHad });

    // ディスク上は両方 keep.md だけ。index が違う。
    expect(fingerprint(withMissing)).not.toBe(fingerprint(neverHad));
  });

  it('🔴 git add しただけでは指紋が変わらない（コミットで stale にしない）', () => {
    // 列挙順に依存させると、新規ファイルが追跡ブロック側へ移って行の順序が変わり、
    // **内容が 1 バイトも変わっていないのに指紋が変わる**。ループの実際の順序は
    // 「ゲート green → コミット → PR 作成」なので、これは毎周回で再実行を強いる。
    const dir = makeRepo();
    write(dir, 'z-existing.ts', 'z\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir });

    // 追跡済みより手前にソートされる名前を選ぶ（順序依存を踏む形）。
    write(dir, 'a-new.ts', 'a\n');
    const beforeAdd = fingerprint(dir);
    execFileSync('git', ['add', 'a-new.ts'], { cwd: dir });
    expect(fingerprint(dir)).toBe(beforeAdd);
  });
});
