import { describe, expect, it } from 'vitest';
import {
  REQUIRED_REST_COMMANDS,
  authConfigInput,
  formatMissingRestCommands,
  isSuccess,
  curlArgs,
  describeHttpFailure,
  parseCurlResponse,
  pullCreateRequest,
  pullMergeRequest,
  pullReadRequest,
  pullsQueryRequest,
  repoReadRequest,
  requestUrl,
  resolveGitHubToken,
} from './github-rest';

const REPO = { owner: '20m61', repo: 'open-reception' } as const;

describe('資格情報の解決 (#1117)', () => {
  it('GH_TOKEN を読む', () => {
    expect(resolveGitHubToken({ GH_TOKEN: 'xyz' })).toEqual({ token: 'xyz', source: 'GH_TOKEN' });
  });

  it('GH_TOKEN が無ければ GITHUB_TOKEN を読む', () => {
    expect(resolveGitHubToken({ GITHUB_TOKEN: 'abc' })).toEqual({ token: 'abc', source: 'GITHUB_TOKEN' });
  });

  /**
   * 🔴 **`gh` の優先順（原典: 「GH_TOKEN, GITHUB_TOKEN (in order of precedence)」）に揃える。**
   * 環境が制限された `GITHUB_TOKEN` を配り、利用者が権限の広い PAT を `GH_TOKEN` で渡す形が
   * 現実にある。逆順に読むと黙って別の主体として振る舞う。
   * **このサンドボックスは両方を設定しているので、順序は実際に効いている。**
   */
  it('GH_TOKEN を GITHUB_TOKEN より優先する', () => {
    expect(resolveGitHubToken({ GITHUB_TOKEN: 'restricted', GH_TOKEN: 'pat' })).toEqual({
      token: 'pat',
      source: 'GH_TOKEN',
    });
  });

  it('空白だけの値は「設定されていない」として扱う', () => {
    expect(resolveGitHubToken({ GITHUB_TOKEN: '   ', GH_TOKEN: '' })).toEqual({
      token: undefined,
      source: undefined,
    });
  });

  /**
   * 🔴 **下界。** token が無いことを致命にしない。実測（2026-09-15 / このサンドボックス）では
   * 送った `Authorization` は proxy に差し替えられ、**ヘッダ無しでも 200 が返る**。
   * ここで throw すると、実際には publish できる環境を塞ぐ。
   */
  it('前後の空白を落として返す（ヘッダを壊さない）', () => {
    expect(resolveGitHubToken({ GITHUB_TOKEN: '  abc\n' }).token).toBe('abc');
  });

  it('token が無くても throw しない（proxy が資格情報を注入する環境がある）', () => {
    expect(() => resolveGitHubToken({})).not.toThrow();
    expect(resolveGitHubToken({}).token).toBeUndefined();
  });
});

describe('要求の組み立て (#1117)', () => {
  it('PR 照会は head を owner:branch でエンコードし、1 件だけ引く', () => {
    const req = pullsQueryRequest(REPO, 'feat/a b&c');
    expect(req.method).toBe('GET');
    expect(req.path).toBe(
      'repos/20m61/open-reception/pulls?state=all&per_page=1&head=20m61%3Afeat%2Fa%20b%26c',
    );
    expect(req.body).toBeUndefined();
  });

  it('PR 作成は JSON 本体に 4 つの値をそのまま載せる', () => {
    const req = pullCreateRequest(REPO, {
      head: 'feat/a',
      base: 'main',
      title: 'feat: x',
      body: '1 行目\n2 行目 = 記号も通る',
    });
    expect(req.method).toBe('POST');
    expect(req.path).toBe('repos/20m61/open-reception/pulls');
    expect(JSON.parse(req.body ?? '')).toEqual({
      title: 'feat: x',
      head: 'feat/a',
      base: 'main',
      body: '1 行目\n2 行目 = 記号も通る',
    });
  });

  it.each(['head', 'base', 'title'] as const)('PR 作成は %s が空なら組み立てない', (field) => {
    const draft = { head: 'feat/a', base: 'main', title: 'feat: x', body: 'b', [field]: '  ' };
    expect(() => pullCreateRequest(REPO, draft)).toThrow(field);
  });

  it('マージは squash を明示する', () => {
    const req = pullMergeRequest(REPO, 703);
    expect(req.method).toBe('PUT');
    expect(req.path).toBe('repos/20m61/open-reception/pulls/703/merge');
    expect(JSON.parse(req.body ?? '')).toEqual({ merge_method: 'squash' });
  });

  it.each([0, -1, 1.5, Number.NaN])('マージは PR 番号 %s を通さない', (n) => {
    expect(() => pullMergeRequest(REPO, n)).toThrow();
  });

  it('PR 単体の読み出しとリポジトリの読み出しは GET', () => {
    expect(pullReadRequest(REPO, 12)).toEqual({
      method: 'GET',
      path: 'repos/20m61/open-reception/pulls/12',
    });
    expect(repoReadRequest(REPO)).toEqual({ method: 'GET', path: 'repos/20m61/open-reception' });
  });

  it.each([0, -1, 1.5])('PR 単体の読み出しも番号 %s を通さない', (n) => {
    expect(() => pullReadRequest(REPO, n)).toThrow();
  });

  it('URL は api.github.com の下に組み立てる', () => {
    expect(requestUrl({ method: 'GET', path: 'repos/o/r' })).toBe('https://api.github.com/repos/o/r');
  });
});

describe('curl の引数 (#1117)', () => {
  const req = pullCreateRequest(REPO, { head: 'h', base: 'main', title: 't', body: 'b' });

  /**
   * 🔴 **これが本体。** 秘密が argv に載ると `ps` からも、失敗メッセージ
   * （`describeCommandFailure` は argv を連結する）からも漏れる。
   * **漏らさないように書く**のではなく、**argv に渡す経路を持たない**ことで塞ぐ。
   */
  it('argv は token を受け取らない（秘密は stdin の --config から渡す）', () => {
    expect(curlArgs.length).toBe(1);
    const joined = curlArgs(req).join(' ');
    expect(joined).not.toContain('Authorization');
    expect(curlArgs(req)).toContain('--config');
    expect(curlArgs(req)).toContain('-');
  });

  it('stdin の config に Authorization を書く', () => {
    expect(authConfigInput('s3cret')).toBe('header = "Authorization: Bearer s3cret"\n');
  });

  it('token が無ければ config は空（ヘッダを送らない）', () => {
    expect(authConfigInput(undefined)).toBe('');
  });

  it('メソッドと URL と本体を渡す', () => {
    const args = curlArgs(req);
    expect(args).toContain('-X');
    expect(args[args.indexOf('-X') + 1]).toBe('POST');
    expect(args).toContain('--data-binary');
    expect(args[args.indexOf('--data-binary') + 1]).toBe(req.body);
    expect(args.at(-1)).toBe('https://api.github.com/repos/20m61/open-reception/pulls');
  });

  it('本体の無い要求には --data-binary を付けない', () => {
    expect(curlArgs(repoReadRequest(REPO))).not.toContain('--data-binary');
  });

  /**
   * 状態コードを本文の後ろへ 1 行で足す。**これが無いと HTTP 4xx を成功と読む**
   * （curl は `--fail` 無しでは 4xx でも exit 0）。
   */
  it('状態コードを書き出させる', () => {
    const args = curlArgs(req);
    expect(args).toContain('-w');
    expect(args[args.indexOf('-w') + 1]).toBe('\\n%{http_code}');
  });
});

describe('応答の読み取り (#1117)', () => {
  it('末尾行を状態コード、それ以外を本文として読む', () => {
    expect(parseCurlResponse('{"a":1}\n201')).toEqual({ status: 201, body: '{"a":1}' });
  });

  it('本文が複数行でも壊れない', () => {
    expect(parseCurlResponse('{\n  "a": 1\n}\n404')).toEqual({ status: 404, body: '{\n  "a": 1\n}' });
  });

  it('本文が空でも読める', () => {
    expect(parseCurlResponse('\n204')).toEqual({ status: 204, body: '' });
  });

  /**
   * 🔴 **下界。** 書き出しが落ちた出力を「本文の最後の数字」で埋めない。
   * 埋めると、本文だけが返った応答を 200 と誤読して**失敗を成功として通す**。
   */
  it.each(['{"a":1}', '', '200 OK', '{"n":404}\n'])('状態コードを読めない出力は throw する: %j', (out) => {
    expect(() => parseCurlResponse(out)).toThrow();
  });
});

describe('失敗の説明 (#1117)', () => {
  const req = pullMergeRequest(REPO, 9);

  it('状態コードと応答本文を落とさない', () => {
    const msg = describeHttpFailure(req, 405, '{"message":"Pull Request is not mergeable"}');
    expect(msg).toContain('405');
    expect(msg).toContain('not mergeable');
    expect(msg).toContain('repos/20m61/open-reception/pulls/9/merge');
  });

  it('要求の本体（Authorization を含みうる文字列）を持ち出さない', () => {
    expect(describeHttpFailure(req, 500, 'boom')).not.toContain('Authorization');
  });
});

/**
 * 🔴 **push 権限の判定は撤回した（独立レビュー 2 周目）。**
 *
 * かつてここに `evaluatePushCapability` の 3 状態テストが在った。撤回の理由は実測 2 つ:
 * `permissions.push` は `contents:write` の申告で PR 作成に要る `pull_requests:write`
 * とは別物であること、そしてこの環境では proxy が無認証でも `push:true` を返すため
 * **止める側の枝に到達しない**こと。**測っていないものを根拠に止めていた。**
 *
 * 代わりに見るのは到達性そのもので、判定は `isSuccess` が持っている（上の節）。
 * 挙動は `tests/config/publish-path-behavior.test.ts` が実起動で縛る。
 */

describe('欠けているコマンドの名指し (#1117 AC1)', () => {
  /**
   * 🔴 **これが AC1 の「名指しする」。** 元の症状は「PR の実在を確認できませんでした」で、
   * 原因（`gh` が無い）が読み取れなかった。
   */
  it('欠けているコマンド名をそのまま出す', () => {
    expect(formatMissingRestCommands(['curl'])).toContain('curl');
  });

  it('層を取り違えない（資格情報の問題だと言わない）', () => {
    const msg = formatMissingRestCommands(['curl']);
    expect(msg).toContain('資格情報の問題ではありません');
    expect(msg).toContain('バイナリが存在しません');
  });
});

describe('成功判定と必須コマンド (#1117)', () => {
  it.each([200, 201, 204, 299])('%i は成功', (status) => {
    expect(isSuccess(status)).toBe(true);
  });

  /**
   * 🔴 **下界。** 3xx を成功に含めない。`-L` を付けていないので、リダイレクトされた要求は
   * **本体を実行していない**。成功として通すと「マージした」と誤報する。
   */
  it.each([199, 300, 301, 403, 422, 500])('%i は成功ではない', (status) => {
    expect(isSuccess(status)).toBe(false);
  });

  it('curl を必須コマンドとして数える（空にすると存在確認が素通りになる）', () => {
    expect(REQUIRED_REST_COMMANDS).toContain('curl');
  });
});

describe('本体は JSON に限る (#1117)', () => {
  /**
   * 🔴 `curl --data-binary` は先頭 `@` を**ファイル名**として解釈する。壊れ方が
   * 「ローカルのファイルを GitHub へ送る」なので、値で塞ぐ。
   */
  it('JSON でない本体は組み立てない', () => {
    expect(() => curlArgs({ method: 'POST', path: 'repos/o/r/pulls', body: '@/etc/passwd' })).toThrow();
  });

  it.each([
    ['作成', pullCreateRequest(REPO, { head: 'h', base: 'main', title: 't', body: '@x' })],
    ['マージ', pullMergeRequest(REPO, 12)],
  ])('%s の本体は JSON で始まる', (_label, req) => {
    expect(req.body?.[0]).toBe('{');
    expect(() => curlArgs(req)).not.toThrow();
  });
});

describe('周囲の設定を読ませない (#1117 review P2)', () => {
  const req = pullCreateRequest(REPO, { head: 'h', base: 'main', title: 't', body: 'b' });

  /**
   * 🔴 **`-q` は必ず先頭でなければ意味が無い。** curl は既定で `~/.curlrc` を読む。
   * **実測（2026-09-15）**: `write-out = "\nFROM-CURLRC-%{http_code}\n"` を置くと
   * 出力へ 1 行混ざり、`parseCurlResponse` の「末尾行が状態コード」が壊れた。
   * `-q` を付けると消えた。curlrc の `url = …` なら**追加の転送**が起き、
   * `--config` で渡した `Authorization` がその先へも飛ぶ。
   */
  it('-q を先頭に置く（curlrc を読む前に無効化する）', () => {
    expect(curlArgs(req)[0]).toBe('-q');
  });

  it.each([
    ['照会', pullsQueryRequest(REPO, 'main')],
    ['マージ', pullMergeRequest(REPO, 12)],
    ['リポジトリ読み出し', repoReadRequest(REPO)],
  ])('%s も -q を先頭に置く（1 つでも抜けるとその経路だけ穴になる）', (_label, r) => {
    expect(curlArgs(r)[0]).toBe('-q');
  });
});

describe('401 / 403 は「どの層か」を名指しする (#1117 review P1)', () => {
  const req = pullCreateRequest(REPO, { head: 'h', base: 'main', title: 't', body: 'b' });

  /**
   * 🔴 **`gh auth login` の資格情報は環境変数に出ない**（keychain 等に入る）。
   * ログイン済みの端末でも `GH_TOKEN` / `GITHUB_TOKEN` は空のままなので、
   * 「ログインしているのに 401」という原因の見えない失敗になる。
   */
  it.each([401, 403])('%i で token 未設定なら、渡し方を名指しする', (status) => {
    const msg = describeHttpFailure(req, status, '{"message":"Bad credentials"}', undefined);
    expect(msg).toContain('GH_TOKEN');
    expect(msg).toContain('gh auth token');
  });

  it('token を渡していたなら「権限」の話だと言う（層を取り違えない）', () => {
    const msg = describeHttpFailure(req, 403, '{"message":"Resource not accessible"}', 'GH_TOKEN');
    expect(msg).toContain('GH_TOKEN');
    expect(msg).toContain('権限');
    // 渡しているのに「設定されていません」と言わない。
    expect(msg).not.toContain('設定されていません');
  });

  /** 下界。資格情報と無関係な状態では、その話を持ち出さない（毎回出ると読まれなくなる）。 */
  it.each([404, 422, 500])('%i には資格情報の助言を付けない', (status) => {
    expect(describeHttpFailure(req, status, 'boom', undefined)).not.toContain('gh auth token');
  });

  it('どの状態でも token の値そのものは運ばない', () => {
    expect(describeHttpFailure(req, 401, 'boom', 'GH_TOKEN')).not.toContain('Authorization');
  });
});

/**
 * `git-base.ts` から移設した表明 (#1117)。**形は `gh` の argv から HTTP 要求へ変わったが、
 * 守っている不変条件は同じ**なので、そのまま連れてくる（方式を替えたときに前の方式が
 * 守っていたものを落とさない ―― `.claude/rules/opus5-autonomous-loop.md`）。
 *
 * 🔴 **この節は一度、無関係な編集で丸ごと消えた。** 3 状態化のときに
 * `publish 経路の能力判定` を書き換えた範囲がここまで及び、**owner/repo を
 * エンコードしない変異が生存**して初めて気づいた。全変異の当て直しが無ければ
 * 誰も気づかないまま保証が落ちていた ―― 規約の「kill が減っていたら退行」そのもの。
 */
describe('移設した不変条件: クエリとパスを壊さない (#656 / #678 / #702 → #1117)', () => {
  it('クエリを割る文字を通さない', () => {
    // `&` はパラメータを割り、`#` は以降を捨てる。どちらも git のブランチ名として合法。
    const q = pullsQueryRequest({ owner: 'o', repo: 'r' }, 'feat/a&head=o:main').path;
    expect(q).not.toContain('&head=o:main');
    expect(q).toContain('%26head%3Do%3Amain');
  });

  it('スラッシュを含むブランチ名をエンコードする', () => {
    // `%2F` でも生の `/` と同じ結果になることは GitHub API で実測済み。
    const q = pullsQueryRequest(REPO, 'docs/opus-5-loop-profile').path;
    expect(q).toContain('head=20m61%3Adocs%2Fopus-5-loop-profile');
  });

  it.each([
    ['照会', (repo: { owner: string; repo: string }) => pullsQueryRequest(repo, 'b').path],
    [
      '作成',
      (repo: { owner: string; repo: string }) =>
        pullCreateRequest(repo, { head: 'h', base: 'main', title: 't', body: 'b' }).path,
    ],
    ['マージ', (repo: { owner: string; repo: string }) => pullMergeRequest(repo, 12).path],
    ['PR 読み出し', (repo: { owner: string; repo: string }) => pullReadRequest(repo, 12).path],
    ['リポジトリ読み出し', (repo: { owner: string; repo: string }) => repoReadRequest(repo).path],
  ])('%s は owner / repo をエンコードして埋める', (_label, build) => {
    expect(build({ owner: 'o w', repo: 'r&x' })).toContain('repos/o%20w/r%26x');
  });

  it('本文が空でも PR は作れる（本文は無くても PR の意味は壊れない）', () => {
    const req = pullCreateRequest(REPO, { head: 'h', base: 'main', title: 't', body: '' });
    expect(JSON.parse(req.body ?? '').body).toBe('');
  });

  /**
   * 🔴 **改行を含む本文が 1 つの値として往復すること。** `gh api` の `-f key=value` では
   * 「値を 1 argv 要素に収める」ことがこの保証の実体だった（分割すると本文が散る）。
   * JSON へ移した後の等価物がこれ。
   */
  it('改行を含む本文がそのまま往復する', () => {
    const body = '複数行の\n本文（#656）';
    const req = pullCreateRequest(REPO, { head: 'h', base: 'main', title: 't', body });
    expect(JSON.parse(req.body ?? '').body).toBe(body);
  });
});

describe('レビュー指摘の修正が縛られていること (#1117 review m2 / M6)', () => {
  /**
   * 🔴 **`--config` の入力は 1 行 1 オプション。** token に改行が混じると
   * `output = …` のような**任意の curl オプションを注入できる**（レビューが実測）。
   * `trim()` は内部の改行を落とさないので、形そのものを絞る。
   */
  it.each([
    ['改行でオプションを足す', 'abc\noutput = /tmp/pwned'],
    ['引用符でヘッダを壊す', 'ab"c'],
    ['バックスラッシュ', 'ab\\c'],
    ['空白', 'ab c'],
  ])('%s は組み立てない', (_label, token) => {
    expect(() => authConfigInput(token)).toThrow();
  });

  it('値そのものは例外メッセージへ載せない', () => {
    try {
      authConfigInput('secret\noutput = /tmp/pwned');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain('secret');
    }
  });

  /** 下界。GitHub の token に現れる文字は通す（絞りすぎると全部使えなくなる）。 */
  it.each(['ghp_AbC123', 'github_pat_11ABC_def.ghi-jkl', 'abc'])('%s は通す', (token) => {
    expect(authConfigInput(token)).toContain(token);
  });

  /**
   * 🔴 **無期限に待たない。** この呼び出しはゲートより前に居るので、proxy が詰まると
   * 「週次ゲートが黙って走らない」になる（終了コードすら出ない）。
   */
  it('接続と全体の両方にタイムアウトを渡す', () => {
    const args = curlArgs(repoReadRequest(REPO));
    expect(args).toContain('--connect-timeout');
    expect(args).toContain('--max-time');
    expect(Number(args[args.indexOf('--max-time') + 1])).toBeGreaterThan(0);
    expect(Number(args[args.indexOf('--connect-timeout') + 1])).toBeGreaterThan(0);
  });
});
