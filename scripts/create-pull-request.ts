#!/usr/bin/env tsx
/**
 * PR を **REST だけ**で作る (issue #678)。
 *
 * ## なぜ `gh pr create` を呼ばないのか
 *
 * クラウドのサンドボックス（Claude Code on the web / Routine）の `gh` は、PR レビュー用の
 * pinned な操作セットしか GraphQL を通さない。`gh pr create` は本体の POST の前に
 * repo info の GraphQL preamble（`RepositoryInfo`）を撃つため、**内容が正しくても
 * 作成に到達せず 403 で落ちる**。2026-08-10 の週次ゲートで実測した:
 *
 * ```
 * HTTP 403: This GraphQL query (RepositoryInfo, sent by gh pr create/view (repo info preamble))
 * is not enabled for this session ... Use REST via `gh api repos/{owner}/{repo}/...` instead.
 * ```
 *
 * このとき記録は push 済みで PR だけが無い ―― **#656（FAIL が main に載らない）そのもの**が
 * 再生産される。開発をクラウドへ移した以上、PR 作成は全周回の通り道なので、
 * ここを REST に寄せておかないと同じ形の取りこぼしが毎周回起こりうる。
 *
 * ## 使い方
 *
 * ```bash
 * npx tsx scripts/create-pull-request.ts \
 *   --head feat/x --base main --title "feat: ..." --body "本文"
 * ```
 *
 * 成功すると PR の URL を **stdout に 1 行**出す（他の出力は stderr）。
 *
 * ## 保証していること
 *
 * 1. **作成できたという申告を信じない** (#656)。作成の後に、そのブランチを head に持つ PR を
 *    REST で引き直し、**実在を確認できたときだけ** 0 で終わる。
 * 2. **既に PR が在れば成功として扱う。** 同名ブランチでの再実行（週次 routine の作り直し）は
 *    GitHub が 422 を返すが、目的は「記録が PR に載っていること」なので、実在すれば達成である。
 * 3. **失敗の理由（stderr）を落とさない。** `execFileSync` の例外 message は
 *    `Command failed: …` までで理由は stderr に在る。拾わずに報告したせいで、クラウドで
 *    到達しない原因を 3 周にわたって当て推量した実績がある（PR #665）。
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describeCommandFailure } from '../src/domain/governance/command-failure';
import { parseGitHubRepo, pullCreateArgs, pullsQueryPath } from '../src/domain/governance/git-base';

/** 外部コマンドを実行する。失敗したら理由（stderr）まで載せて投げ直す。 */
function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    throw new Error(describeCommandFailure(`${cmd} ${args.join(' ')}`, e));
  }
}

/** 受け付ける引数。**ここに無いキーはエラーにする**（下記 `rejectUnknownOptions`）。 */
const KNOWN_OPTIONS = ['head', 'base', 'title', 'body', 'body-file', 'draft'] as const;

/**
 * 知らない引数で**黙って先へ進まない** (#736 で実際に踏んだ)。
 *
 * 🔴 このスクリプトは長らく未知の引数を無視していた。`--body-file` を渡していた呼び出しは
 * **本文が空のまま PR を作り続け**、書いた根拠（変更理由・変異検証・人間承認の要否）が
 * 1 件も GitHub へ載っていなかった。コミットメッセージに残っていたので気づくのが遅れた。
 *
 * 「渡したのに効かない」は「渡し忘れ」より悪い。**入力を黙って落とさない。**
 */
function rejectUnknownOptions(): void {
  const unknown = process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => a.replace(/^--/, '').split('=')[0]!)
    .filter((name) => !KNOWN_OPTIONS.includes(name as (typeof KNOWN_OPTIONS)[number]));
  if (unknown.length > 0) {
    throw new Error(
      `知らない引数です: ${unknown.map((u) => `--${u}`).join(', ')}\n` +
        `受け付けるのは: ${KNOWN_OPTIONS.map((o) => `--${o}`).join(' / ')}`,
    );
  }
}

/** `--key value` 形式だけを受ける。**値の付いていないキーは黙って既定に倒さない。** */
function readOption(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} に値がありません`);
  }
  return value;
}

function main(): number {
  let head: string | undefined;
  let base: string;
  let title: string | undefined;
  let body: string;
  try {
    rejectUnknownOptions();
    head = readOption('head');
    base = readOption('base') ?? 'main';
    title = readOption('title');

    const bodyFile = readOption('body-file');
    const inlineBody = readOption('body');
    if (bodyFile !== undefined && inlineBody !== undefined) {
      throw new Error('--body と --body-file は同時に指定できません');
    }
    body = bodyFile !== undefined ? readFileSync(bodyFile, 'utf8') : (inlineBody ?? '');
    // 🔴 空本文で作らない。**根拠の無い PR を静かに量産しない。**
    if (body.trim() === '') {
      throw new Error('本文が空です（--body か --body-file を指定してください）');
    }
  } catch (e) {
    console.error(`❌ 引数を読めませんでした: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  if (head === undefined || title === undefined) {
    console.error(
      '使い方: create-pull-request.ts --head <branch> --title <title> [--base <branch>] (--body <body> | --body-file <path>)',
    );
    return 2;
  }

  // owner/repo は remote URL から取る。**追加のネットワークも GraphQL も要らない。**
  let remoteUrl: string;
  try {
    remoteUrl = run('git', ['ls-remote', '--get-url', 'origin']);
  } catch (e) {
    console.error(`❌ origin の URL を取得できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const repo = parseGitHubRepo(remoteUrl);
  if (repo === undefined) {
    // 推測で組み立てない。誤った owner/repo は 404 になり「PR が無い」と誤読される。
    console.error(`❌ origin の URL から owner/repo を読み取れませんでした: ${remoteUrl}`);
    return 2;
  }

  let created: string | undefined;
  let createError: string | undefined;
  try {
    created = run('gh', pullCreateArgs(repo, { head, base, title, body }));
  } catch (e) {
    // ここでは終わらせない。**既に PR が在るなら目的は達成されている**（422 の再実行）。
    createError = e instanceof Error ? e.message : String(e);
  }

  // 🔴 **作成できたと言われても信じない (#656)。** ブランチを head に持つ PR を REST で引き直す。
  // `gh pr list` / `gh pr view` は GraphQL なのでクラウドでは 403 になる。使わない。
  let existing: unknown[];
  try {
    existing = JSON.parse(run('gh', ['api', pullsQueryPath(repo, head)])) as unknown[];
  } catch (e) {
    console.error(`❌ PR の実在を確認できませんでした: ${e instanceof Error ? e.message : String(e)}`);
    if (createError !== undefined) console.error(`   作成時のエラー: ${createError}`);
    console.error('   **push 済みでも main には載っていません。** これが #656 の形です。');
    return 4;
  }

  if (existing.length === 0) {
    console.error('❌ PR を作成できませんでした（ブランチを head に持つ PR が 1 件もありません）。');
    if (createError !== undefined) console.error(`   理由: ${createError}`);
    console.error('   **push 済みでも main には載っていません。** これが #656 の形です。');
    return 4;
  }

  const url = created ?? (existing[0] as { html_url?: string }).html_url ?? '(URL 不明)';
  if (createError !== undefined) {
    console.error(`ℹ️  作成は失敗しましたが、既存の PR が見つかりました（理由: ${createError}）`);
  }
  console.error('✅ PR の実在を REST で確認しました');
  console.log(url);
  return 0;
}

process.exit(main());
