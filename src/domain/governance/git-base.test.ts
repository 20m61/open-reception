import { describe, expect, it, vi } from 'vitest';
import { BASE_REF_PREFERENCE, parseGitHubRepo, parseLsRemoteSymref, resolveBase } from './git-base';

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

describe('parseLsRemoteSymref: 既定ブランチと全ブランチを 1 回の問い合わせで取る (#656)', () => {
  // **ローカルの remote 追跡状態に依存しない**のが要点。クラウドの clone には
  // `refs/remotes/origin/HEAD` が無く、`git symbolic-ref` も `gh repo view` も失敗して
  // orphan ブランチ検査が到達しなかった（PR #661 / #663 の実走で 2 度確認）。
  // `git ls-remote --symref origin` は**リモートに HEAD を尋ねる**ので、ローカルに
  // 何も無くても答えが返る（リポジトリ外から明示 URL で実測して確認済み）。

  const OUTPUT = [
    'ref: refs/heads/main\tHEAD',
    '13074eb\tHEAD',
    '6e74c6e\trefs/heads/docs/opus-5-loop-profile',
    '13074eb\trefs/heads/main',
    '375ad5a\trefs/pull/106/head',
    'abc1234\trefs/tags/v1.0.0',
  ].join('\n');

  it('HEAD の symref から既定ブランチを取る', () => {
    expect(parseLsRemoteSymref(OUTPUT).defaultBranch).toBe('main');
  });

  it('refs/heads/ のブランチだけを列挙する', () => {
    // `refs/pull/*` を混ぜると、PR ごとに存在する擬似 ref が全部 orphan 候補になる。
    expect(parseLsRemoteSymref(OUTPUT).branches).toEqual([
      { name: 'docs/opus-5-loop-profile', sha: '6e74c6e' },
      { name: 'main', sha: '13074eb' },
    ]);
  });

  it('スラッシュを含むブランチ名を壊さない', () => {
    expect(parseLsRemoteSymref('aaa\trefs/heads/feat/a/b').branches).toEqual([
      { name: 'feat/a/b', sha: 'aaa' },
    ]);
  });

  it('symref 行が無ければ既定ブランチは undefined（推測で埋めない）', () => {
    // 誤った既定ブランチ名で判定すると、実在する既定ブランチが orphan に誤検出される。
    const r = parseLsRemoteSymref('13074eb\trefs/heads/main');
    expect(r.defaultBranch).toBeUndefined();
    expect(r.branches).toEqual([{ name: 'main', sha: '13074eb' }]);
  });

  it('symref が refs/heads/ 以外を指していたら undefined', () => {
    expect(parseLsRemoteSymref('ref: refs/something/odd\tHEAD').defaultBranch).toBeUndefined();
  });

  it('空出力は「ブランチ 0 本」として返す（呼び出し側が未検査に倒せるように）', () => {
    // **空を「問題なし」と読ませない。** 呼び出し側は branches が空なら未検査扱いにする。
    expect(parseLsRemoteSymref('')).toEqual({ defaultBranch: undefined, branches: [] });
  });
});

describe('parseGitHubRepo: remote URL から owner/repo を取る (#656)', () => {
  // クラウドのサンドボックスは GitHub GraphQL を絞っており、`gh pr list` は 403 になる:
  //   HTTP 403: This GraphQL query is not enabled for this session — only the pinned set of
  //   PR-review operations is served. Use REST via `gh api repos/{owner}/{repo}/...` instead.
  // REST へ移るには owner/repo が要る。remote URL から取れば追加のネットワークは要らない。

  it.each([
    ['https://github.com/20m61/open-reception.git'],
    ['https://github.com/20m61/open-reception'],
    ['git@github.com:20m61/open-reception.git'],
    ['ssh://git@github.com/20m61/open-reception.git'],
  ])('%s から取れる', (url) => {
    expect(parseGitHubRepo(url)).toEqual({ owner: '20m61', repo: 'open-reception' });
  });

  it('資格情報が埋まった URL でも取れる', () => {
    // クラウドの remote はこの形。ここで落ちると REST へ行けない。
    expect(parseGitHubRepo('https://x-access-token:ghs_XXX@github.com/20m61/open-reception.git'))
      .toEqual({ owner: '20m61', repo: 'open-reception' });
  });

  it('GitHub 以外・読めない形は undefined（推測で組み立てない）', () => {
    // 誤った owner/repo で REST を叩くと 404 になり、「PR が無い」と誤読しかねない。
    expect(parseGitHubRepo('https://gitlab.com/o/r.git')).toBeUndefined();
    expect(parseGitHubRepo('https://github.com/only-owner')).toBeUndefined();
    expect(parseGitHubRepo('')).toBeUndefined();
  });
});
