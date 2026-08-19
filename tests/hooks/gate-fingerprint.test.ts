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
    ['引用符', 'quo"te.md'],
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

  it('🔴 追跡済みファイルを消しても指紋が変わる（削除を「変更なし」にしない）', () => {
    // **コミットしてから消す。** 未追跡のまま消すと `ls-files --others` から単に
    // 消えるだけで、「追跡済みだが作業ツリーに無い」= `missing` の経路を通らない
    // （変異で実証: `missing` を最終ハッシュから外しても素通りしていた）。
    const dir = makeRepo();
    write(dir, 'quo"te.md', 'x\n');
    write(dir, 'keep.md', 'y\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir });
    const before = fingerprint(dir);

    rmSync(join(dir, 'quo"te.md'));
    expect(fingerprint(dir)).not.toBe(before);
  });
});
