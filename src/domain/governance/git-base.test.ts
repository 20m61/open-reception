import { describe, expect, it, vi } from 'vitest';
import {
  BASE_REF_PREFERENCE,
  collectChangedPaths,
  parseGitHubRepo,
  parseLsRemoteSymref,
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

  // 🔴 **`-z` を使う** (#718)。既定の git は非 ASCII パスを `"\\346\\227\\245..."` と
  // エスケープするので、`docs/日本語.md` が `docs/` に一致しなくなる。
  // 🔴 **`--no-renames`** (#719)。リネーム検出が効いていると git は新側しか返さないので、
  // ガード対象からの持ち出し（`git mv infra/... docs/...`）が見えなくなる。
  const DIFF = 'diff --name-only --no-renames -z abc123 HEAD';
  const STATUS = 'status --porcelain --no-renames -uall -z';

  it('両方成功したら failures は空で、コミット済みと未コミットを合わせて返す', () => {
    const run = runnerFailing([], {
      [DIFF]: 'src/a.ts\0src/b.ts\0',
      [STATUS]: ' M src/c.ts\0?? src/d.ts\0',
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
    const run = runnerFailing([STATUS], { [DIFF]: 'src/a.ts\0' });
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
      [DIFF]: 'src/a.ts\0',
      [STATUS]: ' M src/a.ts\0',
    });
    expect(collectChangedPaths(run, 'abc123').paths).toEqual(['src/a.ts']);
  });

  it('空のレコードは落とすが、パスの一部である空白は削らない (#718)', () => {
    // 🔴 **`-z` は正確なバイト列を返す**ので trim してはいけない。git 上は前後に空白を
    // 持つパスも正当で、削ると別のパスになる。行区切りだった頃の trim は「行末の改行を
    // 落とす」ためのもので、`-z` では不要かつ有害。
    // **status 側も見る。** DIFF 側だけだと `record.slice(3).trim()` にする変異が
    // 素通りする（porcelain のパース経路が縛られない）。
    const run = runnerFailing([], {
      [DIFF]: '  src/a.ts  \0',
      [STATUS]: ' M   src/b.ts  \0 M \0',
    });
    expect([...collectChangedPaths(run, 'abc123').paths].sort()).toEqual([
      '  src/a.ts  ',
      '  src/b.ts  ',
    ]);
  });

  it('🔴 リネーム検出を切って呼ぶ（切らないと持ち出しが見えない / #719）', () => {
    // `--no-renames` が無いと git は新側しか返さず、
    // `git mv infra/lib/stacks/認証.ts docs/x.md` の旧側が消える。
    // **この引数が落ちると #719 がそのまま再発する**ので、引数そのものを縛る。
    const calls: string[] = [];
    const run = (args: ReadonlyArray<string>): string | null => {
      calls.push(key(args));
      return '';
    };
    collectChangedPaths(run, 'abc123');
    expect(calls).toContain(DIFF);
    expect(calls).toContain(STATUS);
    for (const call of calls) expect(call).toContain('--no-renames');
  });

  it('リネームは削除 + 追加として両方返る (#719)', () => {
    // `--no-renames` を付けた git の実出力の形（実測）。R/C レコードは出ない。
    const run = runnerFailing([], {
      [DIFF]: 'docs/移動.md\0infra/lib/stacks/認証.ts\0',
      [STATUS]: 'A  docs/新.md\0D  src/app/page.tsx\0',
    });
    expect([...collectChangedPaths(run, 'abc123').paths].sort()).toEqual([
      'docs/新.md',
      'docs/移動.md',
      'infra/lib/stacks/認証.ts',
      'src/app/page.tsx',
    ]);
  });

  it('非 ASCII パスがエスケープされない形で読める (#718)', () => {
    // 既定の git は `"docs/\\346\\227\\245..."` を返し `/^docs\\//` に一致しなくなる。
    const run = runnerFailing([], {
      [DIFF]: 'docs/日本語.md\0infra/lib/stacks/認証.ts\0',
      [STATUS]: '?? docs/未追跡.md\0',
    });
    expect([...collectChangedPaths(run, 'abc123').paths].sort()).toEqual([
      'docs/日本語.md',
      'docs/未追跡.md',
      'infra/lib/stacks/認証.ts',
    ]);
  });

  it('引用符を含むパスも壊さない (#718)', () => {
    // `core.quotePath=false` でも `"` を含むパスは引用されるが、`-z` は一切引用しない。
    const run = runnerFailing([], { [DIFF]: '変な"名前.txt\0', [STATUS]: '' });
    expect(collectChangedPaths(run, 'abc123').paths).toEqual(['変な"名前.txt']);
  });

  it('未追跡ディレクトリの畳み込みを防ぐ -uall を使う', () => {
    // `-uall` が抜けると未追跡ディレクトリが `src/foo/` の 1 行へ畳まれ、
    // 中のファイルがまるごと判定から消える（実際に踏んだ）。
    const calls: string[] = [];
    const run = (args: ReadonlyArray<string>): string | null => {
      calls.push(key(args));
      return key(args) === STATUS ? '?? src/foo/a.ts\0' : '';
    };
    expect(collectChangedPaths(run, null).paths).toEqual(['src/foo/a.ts']);
    expect(calls).toContain(STATUS);
  });
});
