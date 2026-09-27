/**
 * `check-publish-path.ts` と `evaluate-gate-runs.ts` の**倒れ方**を実行で縛る (#1117)。
 *
 * ## なぜ要るか（実測）
 *
 * 独立レビューが、この 2 本に対して次の変異が**リポジトリ全体のテストを素通り**することを
 * 示した:
 *
 * - `check-publish-path.ts` の `if (verdict.capability === 'denied')` を `if (false)` に
 *   → 74 files / 1108 tests 全 PASS。AC3 の判定を丸ごと無効化しても誰も気づかない
 * - `evaluate-gate-runs.ts` の問い合わせ失敗を `branchesWithPullRequest.push(...)` に
 *   （＝「問い合わせられない」を「PR がある」と読む fail-open）
 *   → 112 files / 2155 tests 全 PASS。**#656 の網が無言で無効化される**
 *
 * どちらも「純関数はテストされているが、それを使っているかは誰も見ていない」型。
 * ソースの grep では届かないので、**PATH ごと差し替えて実際に起動する**。
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { curlArgs, parseCurlResponse, repoReadRequest } from '../../src/domain/governance/github-rest';
import { SPAWN_TIMEOUT_MS, cleanupStubDirs, readLog, runScriptWithStubs } from './helpers/stub-bin';
import { makeTempDir } from '../helpers/temp';

const PUBLISH_CHECK = 'scripts/check-publish-path.ts';
const EVALUATE = 'scripts/evaluate-gate-runs.ts';

/** `git ls-remote --symref origin` の形。既定ブランチ + 取りこぼし候補 1 本。 */
const LS_REMOTE = [
  'ref: refs/heads/main\tHEAD',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tHEAD',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/main',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/feat/lonely',
  '',
].join('\n');

/** 猶予（24h）の外に置くための古い日時。新しいと `pending` 扱いで指摘が出ない。 */
const OLD_TIP = '2020-01-01T00:00:00+00:00';

const GIT = {
  'ls-remote --get-url origin': 'https://github.com/20m61/open-reception.git',
  'ls-remote --symref origin': LS_REMOTE,
  'show -s': OLD_TIP,
};

afterAll(cleanupStubDirs);

describe('check-publish-path: 到達できたかだけを返す (#1117 AC3)', () => {
  /**
   * 🔴 **push 権限の申告は見ない（撤回した / 独立レビュー 2 周目）。**
   * `permissions.push` は `contents:write` の申告で PR 作成に要る `pull_requests:write`
   * とは別物であり、この環境では proxy が無認証でも `push:true` を返すため、
   * 止める側の枝に到達しなかった。**測っていないものを根拠に止めない。**
   */
  it.each([
    ['権限つきの応答', JSON.stringify({ full_name: 'o/r', permissions: { push: true } })],
    ['push が偽でも到達はしている', JSON.stringify({ full_name: 'o/r', permissions: { push: false } })],
    ['permissions が無くても到達はしている', JSON.stringify({ full_name: 'o/r' })],
  ])('%s → 0（2xx が返れば到達できている）', (_label, body) => {
    const run = runScriptWithStubs(PUBLISH_CHECK, [], {
      responses: [{ body, status: 200 }],
      git: GIT,
    });
    expect(run.code).toBe(0);
  }, SPAWN_TIMEOUT_MS);

  /** 🔴 到達できなかったことだけが確かな事実。ここが唯一の「止める」根拠になる。 */
  it.each([
    ['資格情報が通らない', { body: '{"message":"Bad credentials"}', status: 401 }],
    ['レート制限', { body: '{"message":"API rate limit exceeded"}', status: 403 }],
    ['見つからない', { body: '{"message":"Not Found"}', status: 404 }],
    ['サーバ側の一過性エラー', { body: '{"message":"Server Error"}', status: 500 }],
  ])('%s → 3', (_label, response) => {
    const run = runScriptWithStubs(PUBLISH_CHECK, [], { responses: [response], git: GIT });
    expect(run.code).toBe(3);
  }, SPAWN_TIMEOUT_MS);

  it(
    '通信そのものに失敗しても 3',
    () => {
      expect(runScriptWithStubs(PUBLISH_CHECK, [], { curlFailsWith: 7, git: GIT }).code).toBe(3);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'gh を呼ばない',
    () => {
      const run = runScriptWithStubs(PUBLISH_CHECK, [], {
        responses: [{ body: '{"full_name":"o/r"}', status: 200 }],
        git: GIT,
      });
      expect(readLog(run.dir, 'gh.log')).toBe('');
    },
    SPAWN_TIMEOUT_MS,
  );
});

describe('evaluate-gate-runs: 判定不能と「取りこぼし無し」を混ぜない (#656 / #1117)', () => {
  /**
   * 🔴 **これが #656 の網そのもの。** 問い合わせられなかったことを「PR がある」と
   * 読む変異が、2155 本のテストを素通りした（レビューの実測）。
   */
  it(
    'PR を問い合わせられなければ branch_check_unverified を出し、取りこぼし無しとは言わない',
    () => {
      const run = runScriptWithStubs(EVALUATE, ['--report'], { curlFailsWith: 7, git: GIT });
      const out = `${run.stdout}${run.stderr}`;
      expect(out).toContain('branch_check_unverified');
      expect(out).toContain('未検査');
      // **「取りこぼし 0 件」と読める判定を出さない。**
      expect(out).not.toContain('orphan_branch');
    },
    SPAWN_TIMEOUT_MS,
  );

  /**
   * 下界。「常に未検査」でも上の主張は満たせてしまう。問い合わせが**通れば**
   * 本当に取りこぼしを名指しすること。
   */
  it(
    'PR が 1 件も無いブランチは orphan_branch として名指しする',
    () => {
      const run = runScriptWithStubs(EVALUATE, ['--report'], {
        // 既定ブランチは問い合わせ対象外なので、応答は feat/lonely の 1 回分。
        responses: [{ body: '[]', status: 200 }],
        git: GIT,
      });
      const out = `${run.stdout}${run.stderr}`;
      expect(out).toContain('orphan_branch');
      expect(out).toContain('feat/lonely');
      expect(out).not.toContain('branch_check_unverified');
    },
    SPAWN_TIMEOUT_MS,
  );

  /**
   * 🔴 **空の 2xx を `null` へ倒さない (#1117 review m7)。** 倒すと呼び出し側が
   * `null.length` で TypeError になり、**判定不能が素の例外に化ける** ――
   * `branch_check_unverified` にすらならず、`record-gate-run.sh` では
   * 「点検できませんでした」という別の話に見える。`~/.curlrc` の `output` 指定で
   * 現実に起こりうる形である。
   */
  it(
    '本文が空の 2xx でも未検査として報告する（素の例外で落ちない）',
    () => {
      const run = runScriptWithStubs(EVALUATE, ['--report'], {
        responses: [{ body: '', status: 200 }],
        git: GIT,
      });
      const out = `${run.stdout}${run.stderr}`;
      expect(out).toContain('branch_check_unverified');
      expect(out).not.toContain('TypeError');
    },
    SPAWN_TIMEOUT_MS,
  );

  /**
   * 🔴 **配列でない 2xx を「PR がある」と読まない (#1117 独立レビュー 2 周目 / M4)。**
   * 介在 proxy は 2xx で別形の JSON を返しうる。形を見ずに `length` を読むと
   * `undefined === 0` が false になり、**取りこぼしを見逃す側**へ倒れる。
   */
  it(
    '一覧でない 2xx は未検査として報告する',
    () => {
      const run = runScriptWithStubs(EVALUATE, ['--report'], {
        responses: [{ body: '{"message":"proxy says hi"}', status: 200 }],
        git: GIT,
      });
      const out = `${run.stdout}${run.stderr}`;
      expect(out).toContain('branch_check_unverified');
      expect(out).not.toContain('orphan_branch');
    },
    SPAWN_TIMEOUT_MS,
  );

  /** PR が在れば取りこぼしではない（open / merged / closed のいずれでも）。 */
  it(
    'PR を持つブランチは指摘しない',
    () => {
      const run = runScriptWithStubs(EVALUATE, ['--report'], {
        responses: [{ body: JSON.stringify([{ number: 1, state: 'closed' }]), status: 200 }],
        git: GIT,
      });
      const out = `${run.stdout}${run.stderr}`;
      expect(out).not.toContain('orphan_branch');
      expect(out).not.toContain('branch_check_unverified');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'gh を呼ばない',
    () => {
      const run = runScriptWithStubs(EVALUATE, ['--report'], {
        responses: [{ body: '[]', status: 200 }],
        git: GIT,
      });
      expect(readLog(run.dir, 'gh.log')).toBe('');
    },
    SPAWN_TIMEOUT_MS,
  );
});

/**
 * `-w` の書式を **本物の curl** で 1 度だけ確かめる (#1117 の残存リスク)。
 *
 * 🔴 **stub は `-w` を無視して `本文\n状態` を自前で捏造する。** つまり上の挙動テストは
 * 「curl が実際にこの形で書く」ことを一切保証していない ―― 書式を壊す変更は
 * 文字列一致のテストでしか止まらず、curl を差し替えた瞬間に
 * 「本文の最後の数字を状態コードと読む」世界へ戻りうる。
 *
 * ネットワークは要らない。`file://` なら実 curl の `-w` 展開だけを観測できる
 * （`%{http_code}` は file スキームでは `000` になるが、見たいのは**形**である）。
 */
describe('実 curl の -w 書式 (#1117)', () => {
  it(
    '本文の後ろに改行 1 つと状態コードだけを書く',
    () => {
      const dir = makeTempDir('curl-w-');
      const file = join(dir, 'body.json');
      // 🔴 **最悪の本文**: それ自体が 3 桁の数字 1 行。書式が壊れていれば
      // `parseCurlResponse` がこれを状態コードとして拾い、本文が空になる。
      writeFileSync(file, '404');

      const args = curlArgs(repoReadRequest({ owner: 'o', repo: 'r' }));
      const writeOut = args[args.indexOf('-w') + 1];
      const stdout = execFileSync('curl', ['-q', '-sS', '-w', String(writeOut), `file://${file}`], {
        encoding: 'utf8',
      });

      const parsed = parseCurlResponse(stdout);
      expect(parsed.body).toBe('404');
      expect(Number.isInteger(parsed.status)).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );
});
