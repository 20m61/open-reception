import { describe, expect, it, vi } from 'vitest';
import {
  BASE_REF_PREFERENCE,
  collectChangedPaths,
  parseGitHubRepo,
  parseLsRemoteSymref,
  pullCreateArgs,
  pullMergeArgs,
  pullsQueryPath,
  resolveBase,
} from './git-base';

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

describe('pullsQueryPath: ブランチ名でクエリを壊さない (#656)', () => {
  // 🔴 **壊れ方が安全でない向きに倒れる。** `head` が落ちた問い合わせは
  // `pulls?state=all&per_page=1` になり、**無関係な PR が 1 件返る**（実測）。
  // 呼び出し側はそれを「PR が在る」と読むので、**本物の取りこぼしを見逃す**。
  // git のブランチ名は `&` `#` `%` を許すので、生で埋めてよい文字ではない。

  it('通常のブランチ名を owner:branch の形で載せる', () => {
    const q = pullsQueryPath({ owner: '20m61', repo: 'open-reception' }, 'main');
    expect(q).toContain('repos/20m61/open-reception/pulls');
    expect(q).toContain('state=all');
    expect(q).toContain('head=20m61%3Amain');
  });

  it('スラッシュを含むブランチ名をエンコードする', () => {
    // `%2F` でも生の `/` と同じ結果になることは GitHub API で実測済み。
    const q = pullsQueryPath({ owner: '20m61', repo: 'open-reception' }, 'docs/opus-5-loop-profile');
    expect(q).toContain('head=20m61%3Adocs%2Fopus-5-loop-profile');
  });

  it('クエリを割る文字を通さない', () => {
    // `&` はパラメータを割り、`#` は以降を捨てる。どちらも git のブランチ名として合法。
    const q = pullsQueryPath({ owner: 'o', repo: 'r' }, 'feat/a&head=o:main');
    expect(q).not.toContain('&head=o:main');
    expect(q).toContain('%26head%3Do%3Amain');
  });

  it('owner と repo もエンコードする', () => {
    expect(pullsQueryPath({ owner: 'o w', repo: 'r&x' }, 'b')).toContain('repos/o%20w/r%26x/pulls');
  });
});

describe('pullCreateArgs: PR 作成も REST で行う (#678)', () => {
  // 🔴 **`gh pr create` は使えない。** クラウド Routine セッションの `gh` は PR レビュー用の
  // pinned な操作セットしか許されておらず、`gh pr create` が内部で撃つ GraphQL クエリ
  // （`RepositoryInfo` = repo info preamble）が 403 で拒否される。2026-08-10 の週次ゲートで実測:
  //   HTTP 403: This GraphQL query (RepositoryInfo, sent by gh pr create/view (repo info preamble))
  //   is not enabled for this session ... Use REST via `gh api repos/{owner}/{repo}/...` instead.
  // 記録は push 済みなのに PR が無い状態＝#656 そのものが再生産される。

  const repo = { owner: '20m61', repo: 'open-reception' };
  const draft = {
    head: 'chore/gate-run-20260810',
    base: 'main',
    title: 'docs(gate-runs): 週次定期ゲート実行結果を記録する（#318）',
    body: '複数行の\n本文（#656）',
  };

  it('GraphQL を撃つ経路（gh pr create）ではなく REST の POST を組み立てる', () => {
    const args = pullCreateArgs(repo, draft);
    expect(args.slice(0, 4)).toEqual(['api', '--method', 'POST', 'repos/20m61/open-reception/pulls']);
    // `gh pr ...` のサブコマンドへ退行していないこと。ここが 403 の入口だった。
    expect(args).not.toContain('pr');
  });

  it('head / base / title / body の値がそのまま載る', () => {
    // 落ちても 422 にならず「別のブランチへ向いた PR」が出来る向きがあるので、値で確かめる。
    const args = pullCreateArgs(repo, draft);
    expect(args).toContain(`head=${draft.head}`);
    expect(args).toContain(`base=${draft.base}`);
    expect(args).toContain(`title=${draft.title}`);
    expect(args).toContain(`body=${draft.body}`);
  });

  it('値は 1 つの argv 要素に収める（改行・空白でシェルに割らせない）', () => {
    // `-f body=...` を分割して渡すと本文が引数として散り、gh は残りを未知の引数として拒否する。
    const args = pullCreateArgs(repo, draft);
    const body = args.find((a) => a.startsWith('body='));
    expect(body).toBe(`body=${draft.body}`);
    expect(body).toContain('\n');
  });

  it('作成した PR の URL を取り出せる形で返す（実在確認へ渡すため）', () => {
    // #656 の要点は「作成できたと言われても信じない」。呼び出し側は返った URL を
    // REST で引き直す。URL が取れない出力形式にすると、その確認自体ができない。
    const args = pullCreateArgs(repo, draft);
    expect(args).toContain('--jq');
    expect(args).toContain('.html_url');
  });

  it('owner / repo をパスにエンコードして埋める', () => {
    const args = pullCreateArgs({ owner: 'o w', repo: 'r&x' }, draft);
    expect(args).toContain('repos/o%20w/r%26x/pulls');
  });

  it('head / base / title が空なら組み立てない（推測で PR を作らない）', () => {
    // parseGitHubRepo と同じ思想。空の head を渡すと GitHub は 422 を返すが、
    // 空の base は既定ブランチへ倒れうる ―― 意図しない先へ向いた PR は検知しにくい。
    expect(() => pullCreateArgs(repo, { ...draft, head: '' })).toThrow();
    expect(() => pullCreateArgs(repo, { ...draft, base: '  ' })).toThrow();
    expect(() => pullCreateArgs(repo, { ...draft, title: '' })).toThrow();
  });

  it('本文が空でも作れる（本文は無くても PR の意味は壊れない）', () => {
    expect(pullCreateArgs(repo, { ...draft, body: '' })).toContain('body=');
  });
});


describe('pullMergeArgs: マージも REST で行う (#702)', () => {
  // 🔴 **`gh pr merge` も 403 になる。** 2026-08-18 の PR #701 で実測:
  //   non-200 OK status code: 403 Forbidden
  //   "This GraphQL query is not enabled for this session — only the pinned set of
  //    PR-review operations is served. Use REST via `gh api repos/{owner}/{repo}/...` instead."
  // #678 で作成側を REST へ移したのと同じ理由が、マージ側にも当てはまる。

  const repo = { owner: '20m61', repo: 'open-reception' };

  it('GraphQL を撃つ経路（gh pr merge）ではなく REST の PUT を組み立てる', () => {
    const args = pullMergeArgs(repo, 701);
    expect(args.slice(0, 4)).toEqual([
      'api',
      '--method',
      'PUT',
      'repos/20m61/open-reception/pulls/701/merge',
    ]);
    expect(args).not.toContain('pr');
  });

  it('squash を明示する（このリポジトリのマージ方法は squash 固定）', () => {
    // **既定に任せない。** GitHub の既定は merge commit で、履歴の方針が変わってしまう。
    // squash されたかは `scripts/check-merge-method.ts` が別途見ているが、
    // ここで明示しないとそもそも間違った方法で入る。
    expect(pullMergeArgs(repo, 701)).toContain('merge_method=squash');
  });

  it('PR 番号は数値として扱う（パスに任意文字列を埋めない）', () => {
    // 文字列をそのまま埋めると `701/../../other` のような値でパスを曲げられる。
    expect(() => pullMergeArgs(repo, Number.NaN)).toThrow();
    expect(() => pullMergeArgs(repo, 0)).toThrow();
    expect(() => pullMergeArgs(repo, 1.5)).toThrow();
  });

  it('owner / repo をエンコードして埋める', () => {
    expect(pullMergeArgs({ owner: 'o w', repo: 'r&x' }, 12)).toContain('repos/o%20w/r%26x/pulls/12/merge');
  });
});

/**
 * 変更パスの収集 (#709)。
 *
 * 収集が**失敗した**ことと、**変更が無かった**ことを区別できないと、`change-risk` は
 * 「停止境界に触れていません」と断定してしまう（測れていないのに安全宣言をする）。
 * ここでは失敗が `failures` として必ず表に出ることを固定する。
 */
describe('collectChangedPaths: 収集失敗を空集合と区別する (#709)', () => {
  /** 引数の配列を 1 本の文字列にして、期待した git 呼び出しかを見る。 */
  const key = (args: ReadonlyArray<string>) => args.join(' ');

  /** 指定したコマンドだけ失敗する runner。 */
  function runnerFailing(failing: ReadonlyArray<string>, outputs: Record<string, string> = {}) {
    return (args: ReadonlyArray<string>): string | null => {
      const k = key(args);
      if (failing.includes(k)) return null;
      return outputs[k] ?? '';
    };
  }

  const DIFF = 'diff --name-only abc123 HEAD';
  const STATUS = 'status --porcelain -uall';

  it('両方成功したら failures は空で、コミット済みと未コミットを合わせて返す', () => {
    const run = runnerFailing([], {
      [DIFF]: 'src/a.ts\nsrc/b.ts\n',
      [STATUS]: ' M src/c.ts\n?? src/d.ts\n',
    });
    const result = collectChangedPaths(run, 'abc123');
    expect(result.failures).toEqual([]);
    expect([...result.paths].sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
  });

  it('🔴 git diff が失敗したら failures に出る（黙って 0 件にしない）', () => {
    // これが #709 の本体。`?? ''` で空文字に落ちると、クリーンなツリーでは
    // 「変更 0 件 → 停止境界に触れていません」と断定されてしまう。
    const run = runnerFailing([DIFF], { [STATUS]: '' });
    const result = collectChangedPaths(run, 'abc123');
    expect(result.paths).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('diff');
  });

  it('🔴 git status が失敗しても failures に出る', () => {
    const run = runnerFailing([STATUS], { [DIFF]: 'src/a.ts\n' });
    const result = collectChangedPaths(run, 'abc123');
    expect(result.paths).toEqual(['src/a.ts']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('status');
  });

  it('両方失敗したら failures が 2 件（片方だけ報告して安心させない）', () => {
    const result = collectChangedPaths(runnerFailing([DIFF, STATUS]), 'abc123');
    expect(result.failures).toHaveLength(2);
  });

  it('起点が無ければ diff は試さず、status の失敗だけを見る', () => {
    const calls: string[] = [];
    const run = (args: ReadonlyArray<string>): string | null => {
      calls.push(key(args));
      return '';
    };
    const result = collectChangedPaths(run, null);
    expect(calls.some((c) => c.startsWith('diff'))).toBe(false);
    expect(result.failures).toEqual([]);
  });

  it('diff と status に同じパスが出ても 1 件にまとめる', () => {
    // 同じファイルをコミットしてさらに手で直した場合に両方へ出る。二重に数えない。
    const run = runnerFailing([], {
      [DIFF]: 'src/a.ts\n',
      [STATUS]: ' M src/a.ts\n',
    });
    expect(collectChangedPaths(run, 'abc123').paths).toEqual(['src/a.ts']);
  });

  it('前後の空白と空行は落とす（空文字をパスとして混ぜない）', () => {
    // 移設前の実装は trim していた。**挙動保存の対象**なので固定する。
    const run = runnerFailing([], {
      [DIFF]: '  src/a.ts  \n\n',
      [STATUS]: ' M   \n',
    });
    expect(collectChangedPaths(run, 'abc123').paths).toEqual(['src/a.ts']);
  });

  it('リネームは新しい側を取り、未追跡ディレクトリの畳み込みを防ぐ -uall を使う', () => {
    const calls: string[] = [];
    const run = (args: ReadonlyArray<string>): string | null => {
      calls.push(key(args));
      return key(args) === STATUS ? 'R  old/a.ts -> new/a.ts\n' : '';
    };
    const result = collectChangedPaths(run, null);
    expect(result.paths).toEqual(['new/a.ts']);
    // `-uall` が抜けると未追跡ディレクトリが 1 行に畳まれ、中のファイルが判定から消える。
    expect(calls).toContain(STATUS);
  });
});
