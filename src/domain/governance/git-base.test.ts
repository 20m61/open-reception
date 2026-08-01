import { describe, expect, it, vi } from 'vitest';
import { BASE_REF_PREFERENCE, resolveBase } from './git-base';

/**
 * 比較起点の解決 (#557)。
 *
 * ゲートの 1 番目（変更量）と末尾（停止境界）が**同じ問いに別々の実装**を持っていたため、
 * 同一実行の中で「47 ファイル」と「7 件」が併記される事故が起きた。1 箇所に寄せたので、
 * ここが両者の唯一の仕様になる。
 */

/** 指定した ref だけが存在し、merge-base も引ける git。 */
function gitWith(refs: Record<string, string | null>) {
  return vi.fn((args: ReadonlyArray<string>) => {
    if (args[0] === 'rev-parse') {
      const ref = args[args.length - 1] ?? '';
      return ref in refs ? 'sha\n' : null;
    }
    if (args[0] === 'merge-base') {
      const ref = args[1] ?? '';
      return refs[ref] ?? null;
    }
    return null;
  });
}

describe('resolveBase', () => {
  it('origin/main を最優先する', () => {
    const base = resolveBase(gitWith({ 'origin/main': 'aaa\n', main: 'bbb\n' }));
    expect(base).toBe('aaa');
  });

  it('origin/main が無ければ main へ落ちる', () => {
    expect(resolveBase(gitWith({ main: 'bbb\n' }))).toBe('bbb');
  });

  it('ref は在るが共通祖先へ到達できなければ次の候補へ進む', () => {
    // 浅い clone で実際に起きる形: `origin/main` は在るが履歴が切り詰められていて
    // merge-base が引けない。ここで諦めると起点不明になり、今度は**過小**に報告する。
    const base = resolveBase(gitWith({ 'origin/main': null, main: 'bbb\n' }));
    expect(base).toBe('bbb');
  });

  it('merge-base が空文字でも到達できなかったものとして扱う', () => {
    expect(resolveBase(gitWith({ 'origin/main': '\n', main: 'bbb\n' }))).toBe('bbb');
  });

  it('どの候補も駄目なら null（作業ツリーだけ見る）', () => {
    expect(resolveBase(gitWith({}))).toBeNull();
  });

  it('シェルが確定した起点があればそれを使う（全消費者で同じ起点になる）', () => {
    // 各消費者が独立に再解決すると、整合は「たまたま同時刻に同じ」に依存する。
    // #557 の症状（同一実行で 47 ファイルと 7 件）はそれ。固定値で構造的に閉じる。
    const git = gitWith({ 'origin/main': 'aaa\n' });
    expect(resolveBase(git, 'pinned-sha')).toBe('pinned-sha');
    expect(git).not.toHaveBeenCalled();
  });

  it('固定値が空なら通常の解決へ落ちる（未設定の env を掴まない）', () => {
    expect(resolveBase(gitWith({ 'origin/main': 'aaa\n' }), '')).toBe('aaa');
    expect(resolveBase(gitWith({ 'origin/main': 'aaa\n' }), '   ')).toBe('aaa');
    expect(resolveBase(gitWith({ 'origin/main': 'aaa\n' }), undefined)).toBe('aaa');
  });

  it('候補は origin/main → main の順で、それ以外を勝手に見ない', () => {
    // 起点が増えると「どこからの差分か」が実行ごとに変わり、数字の意味が揺れる。
    expect(BASE_REF_PREFERENCE).toEqual(['origin/main', 'main']);
  });
});
